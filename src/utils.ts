import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extname } from "node:path";
import pLimit from "p-limit";
import type { FileSystem } from "./lib/file";
import type {
  PreparedChunk,
  Store,
  VectorRecord,
} from "./lib/store";
import type {
  InitialSyncProgress,
  InitialSyncResult,
} from "./lib/sync-helpers";
import { workerManager } from "./lib/worker-manager";

// Extensions that have TreeSitter grammar support for semantic chunking
const GRAMMAR_SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".java",
  ".cs",
  ".rb",
  ".php",
  ".json",
  ".yaml",
  ".yml",
  ".kt",
  ".kts",
  ".swift",
  ".dart",
]);

const META_FILE = path.join(os.homedir(), ".osgrep", "meta.json");
const PROFILE_ENABLED =
  process.env.OSGREP_PROFILE === "1" || process.env.OSGREP_PROFILE === "true";
const SKIP_META_SAVE =
  process.env.OSGREP_SKIP_META_SAVE === "1" ||
  process.env.OSGREP_SKIP_META_SAVE === "true";
const DEFAULT_EMBED_BATCH_SIZE = 24;
const FILE_INDEX_TIMEOUT_MS = (() => {
  const fromEnv = Number.parseInt(
    process.env.OSGREP_FILE_TIMEOUT_MS ?? "",
    10,
  );
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 5000;
})();
const DEFAULT_GRAMMAR_ONLY =
  process.env.OSGREP_ALLOW_FALLBACK === "1" ||
    process.env.OSGREP_ALLOW_FALLBACK === "true"
    ? false
    : true;

// Extensions we consider for indexing to avoid binary noise and improve relevance.
const INDEXABLE_EXTENSIONS = new Set([
// Code
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".cs",
  ".swift",
  ".kt",
  ".scala",
  ".lua",
  ".sh",
  ".sql",
  ".html",
  ".css",
  ".dart",
  ".el",
  ".clj",
  ".ex",
  ".exs",
  ".m",
  ".mm",
  ".f90",
  ".f95",
// Config / Data / Docs
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".md",
  ".mdx",
  ".txt",

  ".gitignore",
  ".dockerfile",
  "dockerfile",
  "makefile",
]);

const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB limit for indexing
const SERVER_LOCK_FILE = (cwd: string) =>
  path.join(cwd, ".osgrep", "server.json");

interface IndexingProfile {
  sections: Record<string, number>;
  metaFileSize?: number;
  metaSaveCount: number;
  metaSaveSkipped: boolean;
  processed: number;
  indexed: number;
}

type IndexCandidate = {
  filePath: string;
  hash: string;
};

type IndexFileResult = {
  chunks: PreparedChunk[];
  indexed: boolean;
};

function now(): bigint {
  return process.hrtime.bigint();
}

function toMs(start: bigint, end?: bigint): number {
  return Number((end ?? now()) - start) / 1_000_000;
}

function resolveEmbedBatchSize(): number {
  const fromEnv = Number.parseInt(process.env.OSGREP_BATCH_SIZE ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(fromEnv, 96);
  }
  if (process.env.OSGREP_LOW_IMPACT === "1") return 24;
  if (process.env.OSGREP_FAST === "1") return 48;
  return DEFAULT_EMBED_BATCH_SIZE;
}

/**
 * Check if a file extension has TreeSitter grammar support.
 * Files with grammar support get semantic chunking (functions, classes, etc.)
 * Files without grammar support use fallback sliding-window chunking.
 */
export function hasGrammarSupport(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return GRAMMAR_SUPPORTED_EXTENSIONS.has(ext);
}

// Check if a file should be indexed (extension and size).
function isIndexableFile(
  filePath: string,
  grammarOnly: boolean = DEFAULT_GRAMMAR_ONLY,
): boolean {
  const ext = extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  if (!INDEXABLE_EXTENSIONS.has(ext) && !INDEXABLE_EXTENSIONS.has(basename)) {
    return false;
  }

  // If grammarOnly is true, skip files without grammar support
  if (grammarOnly && !hasGrammarSupport(filePath)) {
    return false;
  }

  try {
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_FILE_SIZE_BYTES) return false;
    if (stats.size === 0) return false;
  } catch {
    return false;
  }

  return true;
}

export function isIndexablePath(
  filePath: string,
  grammarOnly: boolean = DEFAULT_GRAMMAR_ONLY,
): boolean {
  return isIndexableFile(filePath, grammarOnly);
}

export class MetaStore {
  private data: Record<string, string> = {};
  private loaded = false;
  private saveQueue: Promise<void> = Promise.resolve();

  async load() {
    if (this.loaded) return;

    const loadFile = async (p: string) => {
      const content = await fs.promises.readFile(p, "utf-8");
      return JSON.parse(content);
    };

    try {
      this.data = await loadFile(META_FILE);
    } catch (err) {
      // Try to recover from tmp file if main file is missing or corrupt
      const tmpFile = `${META_FILE}.tmp`;
      try {
        if (fs.existsSync(tmpFile)) {
          console.warn("[MetaStore] Main meta file corrupt/missing, recovering from tmp...");
          this.data = await loadFile(tmpFile);
          // Restore the main file
          await fs.promises.copyFile(tmpFile, META_FILE);
        } else {
          this.data = {};
        }
      } catch {
        this.data = {};
      }
    }
    this.loaded = true;
  }

  async save() {
    // Serialize saves to avoid concurrent writes that could corrupt the file
    // Recover from previous failures so the queue never gets permanently stuck
    this.saveQueue = this.saveQueue
      .catch((err) => {
        console.error("MetaStore save failed (previous):", err);
        // Recover so future saves can still run
      })
      .then(async () => {
        await fs.promises.mkdir(path.dirname(META_FILE), { recursive: true });
        const tmpFile = `${META_FILE}.tmp`;
        await fs.promises.writeFile(
          tmpFile,
          JSON.stringify(this.data, null, 2),
        );
        await fs.promises.rename(tmpFile, META_FILE);
      });

    return this.saveQueue;
  }

  get(filePath: string): string | undefined {
    return this.data[filePath];
  }

  set(filePath: string, hash: string) {
    this.data[filePath] = hash;
  }

  delete(filePath: string) {
    delete this.data[filePath];
  }

  deleteByPrefix(prefix: string) {
    const normalizedPrefix = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
    for (const key of Object.keys(this.data)) {
      if (key.startsWith(normalizedPrefix)) {
        delete this.data[key];
      }
    }
  }
}

export function computeBufferHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function computeFileHash(
  filePath: string,
  readFileSyncFn: (p: string) => Buffer,
): string {
  const buffer = readFileSyncFn(filePath);
  return computeBufferHash(buffer);
}

export function isDevelopment(): boolean {
  // Return false when running from within node_modules
  if (__dirname.includes("node_modules")) {
    return false;
  }
  // Return true only when NODE_ENV is explicitly "development"
  if (process.env.NODE_ENV === "development") {
    return true;
  }
  // Otherwise return false (production/other environments)
  return false;
}

// Self-check for isDevelopment logic (only runs in dev mode with explicit flag)
if (isDevelopment() && process.env.OSGREP_RUN_SELFCHECK === "true") {
  const originalEnv = process.env.NODE_ENV;

  // Test 1: node_modules always returns false
  if (!__dirname.includes("node_modules")) {
    // Can't test node_modules case from outside node_modules
  } else if (isDevelopment() !== false) {
    console.error(
      "[SELFCHECK FAILED] isDevelopment() should return false in node_modules",
    );
    process.exit(1);
  }

  // Test 2: NODE_ENV=development returns true
  process.env.NODE_ENV = "development";
  if (isDevelopment() !== true) {
    console.error(
      "[SELFCHECK FAILED] isDevelopment() should return true when NODE_ENV=development",
    );
    process.exit(1);
  }

  // Test 3: Other values return false
  process.env.NODE_ENV = "production";
  if (isDevelopment() !== false) {
    console.error(
      "[SELFCHECK FAILED] isDevelopment() should return false when NODE_ENV=production",
    );
    process.exit(1);
  }

  process.env.NODE_ENV = undefined;
  if (isDevelopment() !== false) {
    console.error(
      "[SELFCHECK FAILED] isDevelopment() should return false when NODE_ENV is unset",
    );
    process.exit(1);
  }

  // Restore
  process.env.NODE_ENV = originalEnv;
  console.log("[SELFCHECK PASSED] isDevelopment() logic is correct");
}

export async function listStoreFileHashes(
  store: Store,
  storeId: string,
): Promise<Map<string, string | undefined>> {
  const byExternalId = new Map<string, string | undefined>();
  for await (const file of store.listFiles(storeId)) {
    const externalId = file.external_id ?? undefined;
    if (!externalId) continue;
    const metadata = file.metadata;
    const hash: string | undefined =
      metadata && typeof metadata.hash === "string" ? metadata.hash : undefined;
    byExternalId.set(externalId, hash);
  }
  return byExternalId;
}

// File size limits (in bytes) to prevent hanging on massive files
const MAX_CODE_SIZE = 1024 * 1024; // 1MB for code
const MAX_DATA_SIZE = 10 * 1024;   // 10KB for JSON/YAML data files
const DATA_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".xml", ".csv"]);

export async function indexFile(
  store: Store,
  storeId: string,
  filePath: string,
  fileName: string,
  metaStore?: MetaStore,
  profile?: IndexingProfile,
  preComputedBuffer?: Buffer,
  preComputedHash?: string,
  forceIndex?: boolean,
): Promise<IndexFileResult> {
  const indexStart = PROFILE_ENABLED ? now() : null;

  // Check file size first
  try {
    const stats = await fs.promises.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const limit = DATA_EXTENSIONS.has(ext) ? MAX_DATA_SIZE : MAX_CODE_SIZE;
    
    if (stats.size > limit) {
      if (process.env.OSGREP_VERBOSE) {
        console.log(`[skip] ${fileName} too large (${(stats.size / 1024).toFixed(1)}KB > ${(limit / 1024).toFixed(1)}KB)`);
      }
      return { chunks: [], indexed: false };
    }
  } catch {
    // If stat fails, we'll likely fail at readFile too, so just continue
  }

  let buffer: Buffer;
  let hash: string;

  if (preComputedBuffer && preComputedHash) {
    buffer = preComputedBuffer;
    hash = preComputedHash;
  } else {
    buffer = await fs.promises.readFile(filePath);
    if (buffer.length === 0) {
      return { chunks: [], indexed: false };
    }
    hash = computeBufferHash(buffer);
  }

  const contentString = buffer.toString("utf-8");

  if (!forceIndex && metaStore) {
    const cachedHash = metaStore.get(filePath);
    if (cachedHash === hash) {
      return { chunks: [], indexed: false };
    }
  }

  const options = {
    external_id: filePath,
    overwrite: true,
    metadata: {
      path: filePath,
      hash,
    },
    content: contentString,
  };

  let chunks: PreparedChunk[] = [];
  let indexed = false;

  try {
    chunks = await store.indexFile(storeId, contentString, options);
    indexed = true;
  } catch (_err) {
    // Fallback for weird encodings
    chunks = await store.indexFile(
      storeId,
      new File([new Uint8Array(buffer)], fileName, { type: "text/plain" }),
      options,
    );
    indexed = true;
  }

  // DEFERRED: We do NOT update the meta store here anymore.
  // We only update it after the vectors are successfully written to the DB.
  // if (indexed && metaStore) {
  //   metaStore.set(filePath, hash);
  // }

  if (indexed && PROFILE_ENABLED && indexStart && profile) {
    profile.sections.index = (profile.sections.index ?? 0) + toMs(indexStart);
  }

  return { chunks, indexed };
}

export async function preparedChunksToVectors(
  chunks: PreparedChunk[],
): Promise<VectorRecord[]> {
  if (chunks.length === 0) return [];
  const hybrids = await workerManager.computeHybrid(
    chunks.map((chunk) => chunk.content),
  );
  return chunks.map((chunk, idx) => {
    const hybrid = hybrids[idx] ?? { dense: [], colbert: Buffer.alloc(0), scale: 1 };
    return {
      ...chunk,
      vector: hybrid.dense,
      colbert: hybrid.colbert,
      colbert_scale: hybrid.scale,
    };
  });
}

export interface InitialSyncOptions {
  grammarOnly?: boolean;
  verbose?: boolean;
}

export async function initialSync(
  store: Store,
  fileSystem: FileSystem,
  storeId: string,
  repoRoot: string,
  dryRun?: boolean,
  onProgress?: (info: InitialSyncProgress) => void,
  metaStore?: MetaStore,
  signal?: AbortSignal,
  options?: InitialSyncOptions,
): Promise<InitialSyncResult> {
  const grammarOnly = options?.grammarOnly ?? DEFAULT_GRAMMAR_ONLY;
  const verbose = options?.verbose ?? false;
  const logVerbose = (message: string) => {
    if (verbose) {
      console.log(message);
    }
  };

  if (metaStore) {
    await metaStore.load();
  }

  const EMBED_BATCH_SIZE = resolveEmbedBatchSize();
  const profile: IndexingProfile | undefined = PROFILE_ENABLED
    ? {
      sections: {},
      metaSaveCount: 0,
      metaSaveSkipped: SKIP_META_SAVE,
      metaFileSize: undefined,
      processed: 0,
      indexed: 0,
    }
    : undefined;

  const totalStart = PROFILE_ENABLED ? now() : null;

  // 1. Scan existing store to find what we already have
  const dbPaths = new Set<string>();
  let storeIsEmpty = false;
  let storeHashes: Map<string, string | undefined> = new Map();
  let initialDbCount = 0;
  const storeScanStart = PROFILE_ENABLED ? now() : null;

  try {
    for await (const file of store.listFiles(storeId)) {
      const externalId = file.external_id ?? undefined;
      if (!externalId) continue;
      dbPaths.add(externalId);
      if (!metaStore) {
        const metadata = file.metadata;
        const hash: string | undefined =
          metadata && typeof metadata.hash === "string"
            ? metadata.hash
            : undefined;
        storeHashes.set(externalId, hash);
      }
    }
    initialDbCount = dbPaths.size;
    storeIsEmpty = dbPaths.size === 0;
  } catch (_err) {
    storeIsEmpty = true;
  }

  logVerbose(`[sync] DB scan: ${initialDbCount} files in store, storeIsEmpty=${storeIsEmpty}`);

  if (PROFILE_ENABLED && storeScanStart && profile) {
    profile.sections.storeScan =
      (profile.sections.storeScan ?? 0) + toMs(storeScanStart);
  }

  if (metaStore && storeHashes.size === 0) {
    storeHashes = new Map();
  }

  // 2. Walk file system and apply the VELVET ROPE filter
  const fileWalkStart = PROFILE_ENABLED ? now() : null;

  // Start worker warmup early so it's ready when scanning finishes
  if (!dryRun) {
    workerManager.warmup().catch(() => { });
  }

  // Files on disk that are not gitignored.
  const allFiles: string[] = [];
  for await (const file of fileSystem.getFiles(repoRoot)) {
    allFiles.push(file);
  }
  const aliveFiles = allFiles.filter(
    (filePath) => !fileSystem.isIgnored(filePath, repoRoot)
  );

  if (PROFILE_ENABLED && fileWalkStart && profile) {
    profile.sections.fileWalk =
      (profile.sections.fileWalk ?? 0) + toMs(fileWalkStart);
  }

  // Apply extension filter to pick index candidates.
  const repoFiles = aliveFiles.filter((filePath) =>
    isIndexableFile(filePath, grammarOnly),
  );
  if (verbose && grammarOnly) {
    const skippedCount = aliveFiles.length - repoFiles.length;
    if (skippedCount > 0) {
      console.log(
        `[scan] Skipping ${skippedCount} unsupported file(s); fallback disabled`,
      );
    }
  }
  logVerbose(
    `[scan] Found ${repoFiles.length} indexable file(s) (grammarOnly=${grammarOnly})`,
  );

  // C. Determine Staleness
  // Stale = In DB, but not in 'aliveFiles' (meaning deleted from disk or added to .gitignore)
  const diskPaths = new Set(aliveFiles);

  // 3. Delete stale files (files in DB but not on disk)
  const stalePaths = Array.from(dbPaths).filter((p) => !diskPaths.has(p));
  const total = repoFiles.length;
  let processed = 0;
  let indexed = 0;
  let pendingIndexCount = 0;
  let writeBuffer: VectorRecord[] = [];
  const embedQueue: PreparedChunk[] = [];

  const flushWriteBuffer = async (force = false) => {
    if (dryRun) return;
    if (writeBuffer.length === 0) return;
    if (!force && writeBuffer.length < 500) return;
    const toWrite = writeBuffer;
    writeBuffer = [];
    const writeStart = PROFILE_ENABLED ? now() : null;
    logVerbose(
      `[db] Writing batch of ${toWrite.length} vector record(s) (force=${force})`,
    );

    try {
      await store.insertBatch(storeId, toWrite);
      logVerbose(`[db] Batch write successful (${toWrite.length} records)`);
    } catch (err) {
      // If a batch fails to insert, log the error and skip these records.
      // This prevents one problematic file from crashing the entire indexing process.
      const errorMsg = err instanceof Error ? err.message : String(err);
      const affectedFiles = [...new Set(toWrite.map((r) => r.path as string))];
      console.error(
        `\n[error] Database write failed (skipping ${toWrite.length} records): ${errorMsg}`,
      );
      if (verbose) {
        console.error(
          `[error] Affected files:\n  - ${affectedFiles.join("\n  - ")}`,
        );
      }
      // Do NOT re-throw. We consume the error and continue with the rest of the indexing.
      return;
    }

    // CHECKPOINTING FIX: Update meta store only after successful write
    if (metaStore) {
      const uniquePaths = new Set(toWrite.map(r => r.path as string));
      for (const p of uniquePaths) {
        // We need the hash. Since we don't have it handy in a map here easily without looking up,
        // we can rely on the fact that 'toWrite' contains the records.
        // Optimization: Create a map of path -> hash from the batch
        const record = toWrite.find(r => r.path === p);
        if (record && record.hash) {
          metaStore.set(p, record.hash as string);
        }
      }
    }

    if (PROFILE_ENABLED && writeStart && profile) {
      profile.sections.tableWrite =
        (profile.sections.tableWrite ?? 0) + toMs(writeStart);
    }
  };

  // const flushEmbedQueue = async (force = false) => {
  //   // This function is kept for backward compatibility/reference but should not be used
  //   // in favor of the new inline queueFlush logic in initialSync.
  //   if (dryRun) {
  //     embedQueue.length = 0;
  //     return;
  //   }
  // };

  if (PROFILE_ENABLED && profile) {
    profile.processed = total;
  }

  const CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length || 4));
  const limit = pLimit(CONCURRENCY);
  const BATCH_SIZE = 5; // Small batches keep memory pressure predictable

  const candidates: IndexCandidate[] = [];
  let embedFlushQueue = Promise.resolve();

  // Process files in batches (hashing + change detection only)
  for (let i = 0; i < repoFiles.length; i += BATCH_SIZE) {
    if (signal?.aborted) break;
    const batch = repoFiles.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map((filePath) =>
        limit(async () => {
          try {
            const buffer = await fs.promises.readFile(filePath);
            const hashStart = PROFILE_ENABLED ? now() : null;
            const hash = computeBufferHash(buffer);

            if (PROFILE_ENABLED && hashStart && profile) {
              profile.sections.hash =
                (profile.sections.hash ?? 0) + toMs(hashStart);
            }

            let existingHash: string | undefined;
            if (metaStore) {
              existingHash = metaStore.get(filePath);
            } else {
              existingHash = storeHashes.get(filePath);
            }

            processed += 1;
            const shouldIndex =
              storeIsEmpty || !existingHash || existingHash !== hash;

            if (shouldIndex) {
              if (dryRun) {
                indexed += 1;
              } else {
                candidates.push({ filePath, hash });
              }
              pendingIndexCount += 1;
            }

            onProgress?.({
              processed,
              indexed,
              total,
              filePath,
              phase: "scanning",
            });
          } catch (err) {
            onProgress?.({
              processed,
              indexed,
              total,
              filePath,
              phase: "scanning",
              error: err instanceof Error ? err.message : "Unknown error",
            });
          }
        }),
      ),
    );
  }

  // Log summary after scanning
  const skippedCount = total - candidates.length;
  if (skippedCount > 0) {
    logVerbose(
      `[scan] ${candidates.length} file(s) need indexing, ${skippedCount} unchanged (skipped)`,
    );
  }

  // Single delete for stale + changed paths
  if (!dryRun) {
    const deleteTargets = Array.from(
      new Set([...stalePaths, ...candidates.map((c) => c.filePath)]),
    );
    if (deleteTargets.length > 0) {
      logVerbose(
        `[sync] Deleting ${deleteTargets.length} file(s) from DB (stale=${stalePaths.length}, reindex=${candidates.length})`,
      );
      const staleStart = PROFILE_ENABLED ? now() : null;
      await store.deleteFiles(storeId, deleteTargets);
      if (PROFILE_ENABLED && staleStart && profile) {
        profile.sections.staleDeletes =
          (profile.sections.staleDeletes ?? 0) + toMs(staleStart);
      }
    }
    if (metaStore && stalePaths.length > 0) {
      stalePaths.forEach((p) => metaStore.delete(p));
      await metaStore.save();
    }
  } else if (stalePaths.length > 0) {
    for (const p of stalePaths) {
      console.log("Dry run: would delete", p);
    }
  }

  if (!dryRun && !storeIsEmpty) {
    storeIsEmpty =
      initialDbCount - stalePaths.length - candidates.length <= 0;
  }

  const queueFlush = async (force = false) => {
    // Logic for batching chunks for embedding worker
    while (
      embedQueue.length >= EMBED_BATCH_SIZE ||
      (force && embedQueue.length > 0)
    ) {
      const batch = embedQueue.splice(0, EMBED_BATCH_SIZE);
      const texts = batch.map((c) => c.content);
      try {
        const embeddings = await workerManager.computeHybrid(texts);
        for (let i = 0; i < batch.length; i++) {
          const c = batch[i];
          const e = embeddings[i];
          writeBuffer.push({
            id: c.id,
            content: c.content,
            path: c.path,
            hash: c.hash,
            start_line: c.start_line,
            end_line: c.end_line,
            chunk_index: c.chunk_index,
            is_anchor: c.is_anchor,  // CRITICAL: needed for listFiles query
            context_prev: c.context_prev,
            context_next: c.context_next,
            chunk_type: c.chunk_type,
            vector: e.dense,
            colbert: e.colbert,
            colbert_scale: e.scale,
          });
        }
        await flushWriteBuffer(false);
      } catch (err) {
        // If a batch fails, we log it and SKIP these chunks.
        // This prevents one bad file from crashing/hanging the entire process.
        const errorMsg = err instanceof Error ? err.message : String(err);
        const affectedFiles = [...new Set(batch.map((c) => c.path))];
        console.error(
          `\n[error] Embedding batch failed (skipping ${batch.length} chunks): ${errorMsg}`,
        );
        if (verbose) {
          console.error(
            `[error] Affected files:\n  - ${affectedFiles.join("\n  - ")}`,
          );
        }
        // Do NOT re-throw. We consume the error and continue to the next batch.
      }
    }
  };

  // Wrap the flushing logic to chain promises
  const queueFlushWrapper = (force = false) => {
    embedFlushQueue = embedFlushQueue.then(() => queueFlush(force));
    return embedFlushQueue;
  };

  // Second pass: chunk + embed + write using global batching (parallel chunking)
  if (!dryRun) {
    if (repoFiles.length > 0) {
      logVerbose(
        "[index] Waiting for embedding worker to be ready...",
      );
      // Ensure warmup is complete before flooding the queue
      await workerManager.warmup();
      
      onProgress?.({
        processed,
        indexed,
        total,
        candidates: candidates.length,
        phase: "indexing",
      });
    }
    const INDEX_BATCH = 50;
    for (let i = 0; i < candidates.length; i += INDEX_BATCH) {
      const slice = candidates.slice(i, i + INDEX_BATCH);
      await Promise.all(
        slice.map((candidate) =>
          limit(async () => {
            if (signal?.aborted) return;
            let timeoutId: NodeJS.Timeout | undefined;
            let timedOut = false;
            let indexPromise: Promise<IndexFileResult> | null = null;
            try {
              const fileStart = PROFILE_ENABLED ? now() : null;
              const relPath = path.relative(repoRoot, candidate.filePath);
              logVerbose(`[index] Chunking ${relPath}`);
              const buffer = await fs.promises.readFile(candidate.filePath);
              indexPromise = indexFile(
                store,
                storeId,
                candidate.filePath,
                path.basename(candidate.filePath),
                metaStore,
                profile,
                buffer,
                candidate.hash,
                storeIsEmpty,
              );
              const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                  timedOut = true;
                  reject(
                    new Error(
                      `Indexing timed out after ${FILE_INDEX_TIMEOUT_MS}ms`,
                    ),
                  );
                }, FILE_INDEX_TIMEOUT_MS);
              });
              const { chunks, indexed: didIndex } = await Promise.race([
                indexPromise,
                timeoutPromise,
              ]);
              const duration =
                PROFILE_ENABLED && fileStart ? toMs(fileStart) : undefined;
              logVerbose(
                `[index] ${didIndex ? "Indexed" : "Skipped"
                } ${relPath} (${chunks.length} chunks)${duration ? ` in ${duration.toFixed(0)}ms` : ""
                }`,
              );
              pendingIndexCount = Math.max(0, pendingIndexCount - 1);
              if (didIndex) {
                indexed += 1;
                if (chunks.length > 0) {
                  embedQueue.push(...chunks);
                  logVerbose(
                    `[embed] Queue length ${embedQueue.length} after ${relPath}`,
                  );
                  if (embedQueue.length >= EMBED_BATCH_SIZE) {
                    await queueFlushWrapper();
                  }
                }

                // Periodic meta save
                if (metaStore && !SKIP_META_SAVE && indexed % 25 === 0) {
                  const saveStart = PROFILE_ENABLED ? now() : null;
                  metaStore
                    .save()
                    .catch((err) =>
                      console.error("Failed to auto-save meta:", err),
                    );
                  if (PROFILE_ENABLED && saveStart && profile) {
                    profile.metaSaveCount += 1;
                    profile.sections.metaSave =
                      (profile.sections.metaSave ?? 0) + toMs(saveStart);
                  }
                }
              }
              onProgress?.({
                processed,
                indexed,
                total,
                candidates: candidates.length,
                filePath: candidate.filePath,
                phase: "indexing",
              });
              logVerbose(
                `[index] Pending files remaining: ${pendingIndexCount}`,
              );
            } catch (err) {
              if (timedOut) {
                indexPromise?.catch(() => { });
                logVerbose(
                  `[timeout] Skipped ${candidate.filePath} after ${FILE_INDEX_TIMEOUT_MS}ms`,
                );
                pendingIndexCount = Math.max(0, pendingIndexCount - 1);
                onProgress?.({
                  processed,
                  indexed,
                  total,
                  candidates: candidates.length,
                  filePath: candidate.filePath,
                  phase: "indexing",
                  error: `Timed out after ${FILE_INDEX_TIMEOUT_MS}ms`,
                });
                return;
              }
              pendingIndexCount = Math.max(0, pendingIndexCount - 1);
              onProgress?.({
                processed,
                indexed,
                total,
                candidates: candidates.length,
                filePath: candidate.filePath,
                phase: "indexing",
                error: err instanceof Error ? err.message : "Unknown error",
              });
            } finally {
              if (timeoutId) clearTimeout(timeoutId);
              logVerbose(
                `[index] Pending files remaining: ${pendingIndexCount}`,
              );
            }
          }),
        ),
      );
      // Force flush between batches to ensure backpressure
      await queueFlushWrapper(true);
      logVerbose(
        `[embed] Forced flush after batch ${(i + INDEX_BATCH) / INDEX_BATCH}`,
      );
    }
  }

  await queueFlushWrapper(true);
  await flushWriteBuffer(true);

  if (PROFILE_ENABLED && profile) {
    profile.processed = processed;
    profile.indexed = indexed;
  }

  // Final meta save
  if (!dryRun && metaStore) {
    const finalSaveStart = PROFILE_ENABLED ? now() : null;
    await metaStore.save();
    if (PROFILE_ENABLED && finalSaveStart && profile) {
      profile.metaSaveCount += 1;
      profile.sections.metaSave =
        (profile.sections.metaSave ?? 0) + toMs(finalSaveStart);
    }
  }

  // Create/Update FTS & Vector Index only if needed
  if (!dryRun && indexed > 0) {
    const ftsStart = PROFILE_ENABLED ? now() : null;
    await store.createFTSIndex(storeId);
    if (PROFILE_ENABLED && ftsStart && profile) {
      profile.sections.createFTSIndex =
        (profile.sections.createFTSIndex ?? 0) + toMs(ftsStart);
    }
    const vecStart = PROFILE_ENABLED ? now() : null;
    await store.createVectorIndex(storeId);
    if (PROFILE_ENABLED && vecStart && profile) {
      profile.sections.createVectorIndex =
        (profile.sections.createVectorIndex ?? 0) + toMs(vecStart);
    }
  }

  if (PROFILE_ENABLED && totalStart && profile) {
    profile.sections.total = toMs(totalStart);
    const metaSize = await fs.promises
      .stat(META_FILE)
      .then((s) => s.size)
      .catch(() => undefined);
    profile.metaFileSize = metaSize;
    console.log(
      "[profile] timing (ms):",
      Object.fromEntries(
        Object.entries(profile.sections).map(([k, v]) => [
          k,
          Number(v.toFixed(2)),
        ]),
      ),
    );
    console.log(
      "[profile] indexing",
      `processed=${processed} indexed=${indexed} metaSaves=${profile.metaSaveCount} metaSize=${metaSize ?? "n/a"} bytes`,
    );
  }

  return { processed, indexed, total };
}

export function debounce<T extends (...args: any[]) => void>(
  func: T,
  wait: number,
): T {
  let timeout: NodeJS.Timeout;
  return function debounceWrapper(this: unknown, ...args: Parameters<T>) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  } as T;
}

export function formatDenseSnippet(text: string, maxLength = 1500): string {
  const clean = text ?? "";
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}...`;
}

function getServerLockPath(cwd = process.cwd()): string {
  return SERVER_LOCK_FILE(cwd);
}

export async function writeServerLock(
  port: number,
  pid: number,
  cwd = process.cwd(),
  authToken?: string,
): Promise<void> {
  const lockPath = getServerLockPath(cwd);
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.promises.writeFile(
    lockPath,
    JSON.stringify(
      { port, pid, authToken },
      null,
      2,
    ),
    { encoding: "utf-8", mode: 0o600 },
  );
}

export async function readServerLock(
  cwd = process.cwd(),
): Promise<{ port: number; pid: number; authToken?: string } | null> {
  const lockPath = getServerLockPath(cwd);
  try {
    const content = await fs.promises.readFile(lockPath, "utf-8");
    const data = JSON.parse(content);
    if (
      data &&
      typeof data.port === "number" &&
      typeof data.pid === "number"
    ) {
      return {
        port: data.port,
        pid: data.pid,
        authToken: typeof data.authToken === "string" ? data.authToken : undefined,
      };
    }
  } catch (_err) {
    // Missing or malformed lock file -> treat as absent
  }
  return null;
}

export async function clearServerLock(
  cwd = process.cwd(),
): Promise<void> {
  const lockPath = getServerLockPath(cwd);
  try {
    await fs.promises.unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Central Server Registry - Tracks all running osgrep servers across directories.
 * Stored in ~/.osgrep/servers.json for multi-workspace coordination.
 */

const SERVERS_REGISTRY_FILE = path.join(os.homedir(), ".osgrep", "servers.json");

export interface ServerEntry {
  cwd: string;
  port: number;
  pid: number;
  authToken?: string;
}

interface ServersRegistry {
  servers: ServerEntry[];
}

/** Reads the server registry file. Returns empty registry if missing or corrupt. */
async function readRegistry(): Promise<ServersRegistry> {
  try {
    const content = await fs.promises.readFile(SERVERS_REGISTRY_FILE, "utf-8");
    const data = JSON.parse(content);
    if (data && Array.isArray(data.servers)) {
      return data as ServersRegistry;
    }
  } catch (_err) {
    // Missing or malformed registry file -> treat as empty
  }
  return { servers: [] };
}

/** Atomically writes the server registry using tmp file + rename. */
async function writeRegistry(registry: ServersRegistry): Promise<void> {
  const dir = path.dirname(SERVERS_REGISTRY_FILE);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpFile = `${SERVERS_REGISTRY_FILE}.tmp`;
  try {
    await fs.promises.writeFile(
      tmpFile,
      JSON.stringify(registry, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
    await fs.promises.rename(tmpFile, SERVERS_REGISTRY_FILE);
  } catch (err) {
    // Clean up tmp file if rename failed
    try {
      await fs.promises.unlink(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/** Registers a server in the central registry. Replaces any existing entry for the same cwd. */
export async function registerServer(entry: ServerEntry): Promise<void> {
  const registry = await readRegistry();
  // Remove any existing entry for this cwd
  registry.servers = registry.servers.filter((s) => s.cwd !== entry.cwd);
  registry.servers.push(entry);
  await writeRegistry(registry);
}

/** Removes a server from the registry by cwd. Silently ignores errors. */
export async function unregisterServer(cwd: string): Promise<void> {
  try {
    const registry = await readRegistry();
    registry.servers = registry.servers.filter((s) => s.cwd !== cwd);
    await writeRegistry(registry);
  } catch (err) {
    // Ignore errors - registry may be in inconsistent state due to race conditions
    // This is acceptable as the registry is a best-effort tracking mechanism
  }
}

/** Returns all registered servers. May include stale entries. */
export async function listAllServers(): Promise<ServerEntry[]> {
  const registry = await readRegistry();
  return registry.servers;
}

/** Clears the entire server registry. Used after stopping all servers. */
export async function clearAllServers(): Promise<void> {
  await writeRegistry({ servers: [] });
}

/** Checks if a process is running by sending signal 0. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that a process is actually an osgrep server by probing its /health endpoint.
 * This prevents accidentally killing unrelated processes if PIDs get reused.
 *
 * @param port - The port the server should be listening on
 * @param authToken - The auth token to verify the server
 * @param timeoutMs - Timeout for the health check (default: 2000ms)
 * @returns true if the server responds correctly with the given auth token
 */
export async function verifyOsgrepServer(
  port: number,
  authToken?: string,
  timeoutMs = 2000,
): Promise<boolean> {
  if (!authToken) {
    // Without an auth token, we can't verify - fall back to unsafe behavior
    console.warn(
      `[osgrep] Cannot verify server on port ${port}: authToken is missing`,
    );
    return false;
  }

  return new Promise((resolve) => {
    const http = require("node:http") as typeof import("node:http");

    const timeout = setTimeout(() => {
      req.destroy();
      resolve(false);
    }, timeoutMs);

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
      (res) => {
        clearTimeout(timeout);
        // Accept 200 status as confirmation this is our osgrep server
        if (res.statusCode === 200) {
          // Drain the response
          res.resume();
          resolve(true);
        } else {
          res.resume();
          resolve(false);
        }
      },
    );

    req.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });

    req.end();
  });
}
