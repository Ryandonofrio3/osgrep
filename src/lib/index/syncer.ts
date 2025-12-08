
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "../../config";
import { MetaCache, type MetaEntry } from "../store/meta-cache";
import type { VectorRecord } from "../store/types";
import { VectorDB } from "../store/vector-db";
import { isIndexableFile } from "../utils/file-utils";
import { acquireWriterLockWithRetry, type LockHandle } from "../utils/lock";
import { ensureProjectPaths } from "../utils/project-root";
import { getWorkerPool } from "../workers/pool";
import type { ProcessFileResult } from "../workers/worker";
import type { InitialSyncProgress, InitialSyncResult } from "./sync-helpers";
import { walk } from "./walker";

type SyncOptions = {
  projectRoot: string;
  dryRun?: boolean;
  reset?: boolean;
  onProgress?: (info: InitialSyncProgress) => void;
  signal?: AbortSignal;
};

type MetaCacheLike = Pick<
  MetaCache,
  "get" | "getAllKeys" | "put" | "delete" | "close"
>;

async function flushBatch(
  db: VectorDB,
  meta: MetaCacheLike,
  vectors: VectorRecord[],
  pendingMeta: Map<string, MetaEntry>,
  pendingDeletes: string[],
  dryRun?: boolean,
) {
  if (dryRun) return;

  // 1. Write to VectorDB first (source of truth for data)
  if (pendingDeletes.length > 0) {
    await db.deletePaths(pendingDeletes);
  }
  if (vectors.length > 0) {
    await db.insertBatch(vectors);
  }

  // 2. Update MetaCache only after VectorDB write succeeds
  for (const [p, entry] of pendingMeta.entries()) {
    meta.put(p, entry);
  }
}

function createNoopMetaCache(): MetaCacheLike {
  const store = new Map<string, MetaEntry>();
  return {
    get: (filePath: string) => store.get(filePath),
    async getAllKeys() {
      return new Set(store.keys());
    },
    put: (filePath: string, entry: MetaEntry) => {
      store.set(filePath, entry);
    },
    delete: (filePath: string) => {
      store.delete(filePath);
    },
    close: () => { },
  };
}

export async function initialSync(
  options: SyncOptions,
): Promise<InitialSyncResult> {
  const {
    projectRoot,
    dryRun = false,
    reset = false,
    onProgress,
    signal,
  } = options;
  const paths = ensureProjectPaths(projectRoot);

  // Propagate project root to worker processes
  process.env.OSGREP_PROJECT_ROOT = paths.root;

  let lock: LockHandle | null = null;
  const vectorDb = new VectorDB(paths.lancedbDir);
  const treatAsEmptyCache = reset && dryRun;
  let metaCache: MetaCacheLike | null = null;

  try {
    if (!dryRun) {
      lock = await acquireWriterLockWithRetry(paths.osgrepDir);
      // Open MetaCache only after lock is acquired
      metaCache = new MetaCache(paths.lmdbPath);
    } else {
      metaCache = createNoopMetaCache();
    }

    if (!dryRun) {
      const hasRows = await vectorDb.hasAnyRows();
      const hasMeta = (await metaCache.getAllKeys()).size > 0;
      const isInconsistent = (hasRows && !hasMeta) || (!hasRows && hasMeta);

      if (reset || isInconsistent) {
        if (isInconsistent) {
          console.warn(
            "[syncer] Detected inconsistent state (VectorDB/MetaCache mismatch). Forcing re-sync.",
          );
        }
        await vectorDb.drop();

        metaCache.close();
        try {
          fs.rmSync(paths.lmdbPath, { force: true });
        } catch { }
        metaCache = new MetaCache(paths.lmdbPath);
      }
    }

    let total = 0;
    onProgress?.({ processed: 0, indexed: 0, total, filePath: "Scanning..." });

    const pool = getWorkerPool();
    const cachedPaths =
      dryRun || treatAsEmptyCache
        ? new Set<string>()
        : await metaCache.getAllKeys();
    const seenPaths = new Set<string>();
    const visitedRealPaths = new Set<string>();
    const batch: VectorRecord[] = [];
    const pendingMeta = new Map<string, MetaEntry>();
    const pendingDeletes = new Set<string>();
    const batchLimit = Math.max(1, CONFIG.EMBED_BATCH_SIZE);
    const maxConcurrency = Math.max(1, CONFIG.WORKER_THREADS);

    const activeTasks: Promise<void>[] = [];
    let processed = 0;
    let indexed = 0;
    let failedFiles = 0;
    let shouldSkipCleanup = false;
    let flushError: unknown;
    let flushPromise: Promise<void> | null = null;
    let flushLock: Promise<void> = Promise.resolve();

    const markProgress = (filePath: string) => {
      onProgress?.({ processed, indexed, total, filePath });
    };

    const flush = async (force = false) => {
      const shouldFlush =
        force ||
        batch.length >= batchLimit ||
        pendingDeletes.size >= batchLimit ||
        pendingMeta.size >= batchLimit;
      if (!shouldFlush) return;

      const runFlush = async () => {
        const toWrite = batch.splice(0);
        const metaEntries = new Map(pendingMeta);
        const deletes = Array.from(pendingDeletes);
        pendingMeta.clear();
        pendingDeletes.clear();

        const currentFlush = flushBatch(
          vectorDb,
          metaCache!, // Non-null assertion: metaCache is assigned after lock
          toWrite,
          metaEntries,
          deletes,
          dryRun,
        );

        flushPromise = currentFlush;
        try {
          await currentFlush;
        } catch (err) {
          flushError = err;
          shouldSkipCleanup = true;
          throw err;
        } finally {
          if (flushPromise === currentFlush) {
            flushPromise = null;
          }
        }
      };

      flushLock = flushLock.then(runFlush);
      await flushLock;
    };

    const isTimeoutError = (err: unknown) =>
      err instanceof Error && err.message?.toLowerCase().includes("timed out");

    const processFileWithRetry = async (
      relPath: string,
      absPath: string,
    ): Promise<ProcessFileResult> => {
      let retries = 0;
      while (true) {
        try {
          return await pool.processFile({
            path: relPath,
            absolutePath: absPath,
          });
        } catch (err) {
          if (isTimeoutError(err) && retries === 0) {
            retries += 1;
            continue;
          }
          throw err;
        }
      }
    };

    const schedule = async (task: () => Promise<void>) => {
      const taskPromise = task();
      activeTasks.push(taskPromise);
      taskPromise.finally(() => {
        const idx = activeTasks.indexOf(taskPromise);
        if (idx !== -1) activeTasks.splice(idx, 1);
      });
      if (activeTasks.length >= maxConcurrency) {
        await Promise.race(activeTasks);
      }
    };

    for await (const relPath of walk(paths.root, {
      additionalPatterns: ["!**/.git/**", "!**/.osgrep/**"], // exclude .git and .osgrep explicitly if walker doesn't
    })) {
      if (signal?.aborted) {
        shouldSkipCleanup = true;
        break;
      }
      // Walker yields relative paths
      // if (ignoreFilter.ignores(relPath)) continue; // Handled by walker

      const absPath = path.join(paths.root, relPath);

      // Check real path to avoid duplicates and loops
      try {
        const realPath = fs.realpathSync(absPath);
        if (visitedRealPaths.has(realPath)) continue;
        visitedRealPaths.add(realPath);
      } catch {
        // Skip broken symlinks or inaccessible files
        continue;
      }

      if (!isIndexableFile(absPath)) continue;

      await schedule(async () => {
        if (signal?.aborted) {
          shouldSkipCleanup = true;
          return;
        }

        try {
          const stats = await fs.promises.stat(absPath);
          if (!isIndexableFile(absPath, stats.size)) {
            return;
          }

          const cached = treatAsEmptyCache
            ? undefined
            : metaCache!.get(relPath);

          if (
            cached &&
            cached.mtimeMs === stats.mtimeMs &&
            cached.size === stats.size
          ) {
            processed += 1;
            seenPaths.add(relPath);
            markProgress(relPath);
            return;
          }

          const result = await processFileWithRetry(relPath, absPath);

          const metaEntry: MetaEntry = {
            hash: result.hash,
            mtimeMs: result.mtimeMs,
            size: result.size,
          };

          if (result.shouldDelete) {
            if (!dryRun) {
              pendingDeletes.add(relPath);
              pendingMeta.set(relPath, metaEntry);
              await flush(false);
            }
            processed += 1;
            seenPaths.add(relPath);
            markProgress(relPath);
            return;
          }

          if (cached && cached.hash === result.hash) {
            if (!dryRun) {
              metaCache!.put(relPath, metaEntry);
            }
            processed += 1;
            seenPaths.add(relPath);
            markProgress(relPath);
            return;
          }

          if (dryRun) {
            processed += 1;
            indexed += 1;
            seenPaths.add(relPath);
            markProgress(relPath);
            return;
          }

          pendingDeletes.add(relPath);

          if (result.vectors.length > 0) {
            batch.push(...result.vectors);
            pendingMeta.set(relPath, metaEntry);
            indexed += 1;
          } else {
            pendingMeta.set(relPath, metaEntry);
          }

          seenPaths.add(relPath);
          processed += 1;
          markProgress(relPath);

          await flush(false);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") {
            // Treat missing files as deletions.
            pendingDeletes.add(relPath);
            pendingMeta.delete(relPath);
            if (!dryRun) {
              metaCache!.delete(relPath);
            }
            processed += 1;
            markProgress(relPath);
            await flush(false);
            return;
          }
          failedFiles += 1;
          processed += 1;
          seenPaths.add(relPath);
          console.error(`[sync] Failed to process ${relPath}:`, err);
          markProgress(relPath);
        }
      });
    }

    await Promise.allSettled(activeTasks);
    if (signal?.aborted) {
      shouldSkipCleanup = true;
    }

    await flush(true);

    if (flushError) {
      throw flushError instanceof Error
        ? flushError
        : new Error(String(flushError));
    }

    if (!dryRun) {
      onProgress?.({
        processed,
        indexed,
        total,
        filePath: "Creating FTS index...",
      });
      await vectorDb.createFTSIndex();
    }

    const stale = Array.from(cachedPaths).filter((p) => !seenPaths.has(p));
    if (!dryRun && stale.length > 0 && !shouldSkipCleanup) {
      await vectorDb.deletePaths(stale);
      stale.forEach((p) => {
        metaCache!.delete(p);
      });
    }

    // Finalize total so callers can display a meaningful summary.
    total = processed;
    return { processed, indexed, total, failedFiles };
  } finally {
    if (lock) {
      await lock.release();
    }
    metaCache?.close();
    await vectorDb.close();
  }
}
