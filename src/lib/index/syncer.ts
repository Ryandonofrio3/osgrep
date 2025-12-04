import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { CONFIG } from "../../config";
import { ensureProjectPaths } from "../utils/project-root";
import { DEFAULT_IGNORE_PATTERNS } from "./ignore-patterns";
import {
  type InitialSyncProgress,
  type InitialSyncResult,
} from "./sync-helpers";
import { isIndexableFile } from "../utils/file-utils";
import { MetaCache, type MetaEntry } from "../store/meta-cache";
import { VectorDB } from "../store/vector-db";
import { getWorkerPool } from "../workers/pool";
import type { VectorRecord } from "../store/types";
import { acquireWriterLock, type LockHandle } from "../utils/lock";

type SyncOptions = {
  projectRoot: string;
  dryRun?: boolean;
  reset?: boolean;
  onProgress?: (info: InitialSyncProgress) => void;
  signal?: AbortSignal;
};

type GlobOptions = fg.Options;

function buildIgnoreFilter(projectRoot: string) {
  const filter = ignore();
  const gitignore = path.join(projectRoot, ".gitignore");
  if (fs.existsSync(gitignore)) {
    filter.add(fs.readFileSync(gitignore, "utf-8"));
  }
  const osgrepIgnore = path.join(projectRoot, ".osgrepignore");
  if (fs.existsSync(osgrepIgnore)) {
    filter.add(fs.readFileSync(osgrepIgnore, "utf-8"));
  }
  return filter;
}

async function flushBatch(
  db: VectorDB,
  meta: MetaCache,
  vectors: VectorRecord[],
  pendingMeta: Map<string, MetaEntry>,
  pendingDeletes: string[],
  dryRun?: boolean,
) {
  if (dryRun) return;
  if (pendingDeletes.length > 0) {
    await db.deletePaths(pendingDeletes);
  }
  if (vectors.length > 0) {
    await db.insertBatch(vectors);
  }
  for (const [p, entry] of pendingMeta.entries()) {
    meta.put(p, entry);
  }
}

export async function initialSync(options: SyncOptions): Promise<InitialSyncResult> {
  const {
    projectRoot,
    dryRun = false,
    reset = false,
    onProgress,
    signal,
  } = options;
  const paths = ensureProjectPaths(projectRoot);
  let lock: LockHandle | null = null;
  const vectorDb = new VectorDB(paths.lancedbDir);
  let metaCache = new MetaCache(paths.lmdbPath);
  const ignoreFilter = buildIgnoreFilter(paths.root);
  const treatAsEmptyCache = reset && dryRun;

  try {
    lock = await acquireWriterLock(paths.osgrepDir);

    // CRITICAL: Handle reset INSIDE the lock to prevent corruption
    if (reset && !dryRun) {
      await vectorDb.drop();

      metaCache.close();
      try {
        fs.rmSync(paths.lmdbPath, { force: true });
      } catch { }
      metaCache = new MetaCache(paths.lmdbPath);
    }

    const globOptions: GlobOptions = {
      cwd: paths.root,
      dot: false,
      onlyFiles: true,
      unique: true,
      followSymbolicLinks: false,
      ignore: [...DEFAULT_IGNORE_PATTERNS, ".git/**", ".osgrep/**"],
      suppressErrors: true,
      globstar: true,
    };

    let total = 0;
    onProgress?.({ processed: 0, indexed: 0, total, filePath: "Scanning..." });

    const pool = getWorkerPool();
    const cachedPaths = treatAsEmptyCache
      ? new Set<string>()
      : await metaCache.getAllKeys();
    const seenPaths = new Set<string>();
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

      while (flushPromise) {
        await flushPromise;
      }

      const toWrite = batch.splice(0);
      const metaEntries = new Map(pendingMeta);
      const deletes = Array.from(pendingDeletes);
      pendingMeta.clear();
      pendingDeletes.clear();

      flushPromise = flushBatch(
        vectorDb,
        metaCache,
        toWrite,
        metaEntries,
        deletes,
        dryRun,
      );

      try {
        await flushPromise;
      } catch (err) {
        flushError = err;
        shouldSkipCleanup = true;
        throw err;
      } finally {
        flushPromise = null;
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

    for await (const entry of fg.stream("**/*", globOptions)) {
      if (signal?.aborted) {
        shouldSkipCleanup = true;
        break;
      }
      const relPath = entry.toString();
      if (ignoreFilter.ignores(relPath)) continue;

      const absPath = path.join(paths.root, relPath);
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

          const cached = treatAsEmptyCache ? undefined : metaCache.get(relPath);

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

          const result = await pool.processFile({
            path: relPath,
            absolutePath: absPath,
          });

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
            metaCache.put(relPath, metaEntry);
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
            metaCache.delete(relPath);
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

    const stale = Array.from(cachedPaths).filter((p) => !seenPaths.has(p));
    if (!dryRun && stale.length > 0 && !shouldSkipCleanup) {
      await vectorDb.deletePaths(stale);
      stale.forEach((p) => metaCache.delete(p));
    }

    // Finalize total so callers can display a meaningful summary.
    total = processed;
    return { processed, indexed, total, failedFiles };
  } finally {
    if (lock) {
      await lock.release();
    }
    metaCache.close();
    await vectorDb.close();
  }
}
