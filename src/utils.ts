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

const META_FILE = path.join(os.homedir(), ".osgrep", "meta.json");
const PROFILE_ENABLED =
  process.env.OSGREP_PROFILE === "1" || process.env.OSGREP_PROFILE === "true";
const SKIP_META_SAVE =
  process.env.OSGREP_SKIP_META_SAVE === "1" ||
  process.env.OSGREP_SKIP_META_SAVE === "true";
const DEFAULT_EMBED_BATCH_SIZE = 48;

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
  ".env",
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

// Check if a file should be indexed (extension and size).
function isIndexableFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  if (!INDEXABLE_EXTENSIONS.has(ext) && !INDEXABLE_EXTENSIONS.has(basename)) {
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

export function isIndexablePath(filePath: string): boolean {
  return isIndexableFile(filePath);
}

export class MetaStore {
  private data: Record<string, string> = {};
  private loaded = false;
  private saveQueue: Promise<void> = Promise.resolve();

  async load() {
    if (this.loaded) return;
    try {
      const content = await fs.promises.readFile(META_FILE, "utf-8");
      this.data = JSON.parse(content);
    } catch (_e) {
      this.data = {};
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
        await fs.promises.writeFile(
          META_FILE,
          JSON.stringify(this.data, null, 2),
        );
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

  if (indexed && metaStore) {
    metaStore.set(filePath, hash);
  }

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

export async function initialSync(
  store: Store,
  fileSystem: FileSystem,
  storeId: string,
  repoRoot: string,
  dryRun?: boolean,
  onProgress?: (info: InitialSyncProgress) => void,
  metaStore?: MetaStore,
): Promise<InitialSyncResult> {
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

  if (PROFILE_ENABLED && storeScanStart && profile) {
    profile.sections.storeScan =
      (profile.sections.storeScan ?? 0) + toMs(storeScanStart);
  }

  if (metaStore && storeHashes.size === 0) {
    storeHashes = new Map();
  }

  // 2. Walk file system and apply the VELVET ROPE filter
  const fileWalkStart = PROFILE_ENABLED ? now() : null;
  
  // Files on disk that are not gitignored.
  const allFiles = Array.from(fileSystem.getFiles(repoRoot));
  const aliveFiles = allFiles.filter(
    (filePath) => !fileSystem.isIgnored(filePath, repoRoot)
  );

  if (PROFILE_ENABLED && fileWalkStart && profile) {
    profile.sections.fileWalk =
      (profile.sections.fileWalk ?? 0) + toMs(fileWalkStart);
  }

  // Apply extension filter to pick index candidates.
  const repoFiles = aliveFiles.filter((filePath) => isIndexableFile(filePath));

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
    await store.insertBatch(storeId, toWrite);
    if (PROFILE_ENABLED && writeStart && profile) {
      profile.sections.tableWrite =
        (profile.sections.tableWrite ?? 0) + toMs(writeStart);
    }
  };

  const flushEmbedQueue = async (force = false) => {
    if (dryRun) {
      embedQueue.length = 0;
      return;
    }
    while (
      embedQueue.length >= EMBED_BATCH_SIZE ||
      (force && embedQueue.length > 0)
    ) {
      const batch = embedQueue.splice(0, EMBED_BATCH_SIZE);
      const embedStart = PROFILE_ENABLED ? now() : null;
      const vectors = await preparedChunksToVectors(batch);
      if (PROFILE_ENABLED && embedStart && profile) {
        profile.sections.embed =
          (profile.sections.embed ?? 0) + toMs(embedStart);
        profile.sections.embedBatches =
          (profile.sections.embedBatches ?? 0) + 1;
      }
      writeBuffer.push(...vectors);
      await flushWriteBuffer();
    }
  };

  if (PROFILE_ENABLED && profile) {
    profile.processed = total;
  }

  const CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length || 4));
  const limit = pLimit(CONCURRENCY);
  const BATCH_SIZE = 10; // Small batches keep memory pressure predictable

  const candidates: IndexCandidate[] = [];
  let embedFlushQueue = Promise.resolve();

  // Process files in batches (hashing + change detection only)
  for (let i = 0; i < repoFiles.length; i += BATCH_SIZE) {
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

            onProgress?.({ processed, indexed, total, filePath });
          } catch (_err) {
            onProgress?.({ processed, indexed, total, filePath });
          }
        }),
      ),
    );
  }

  // Single delete for stale + changed paths
  if (!dryRun) {
    const deleteTargets = Array.from(
      new Set([...stalePaths, ...candidates.map((c) => c.filePath)]),
    );
    if (deleteTargets.length > 0) {
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

  const queueFlush = (force = false) => {
    embedFlushQueue = embedFlushQueue.then(() => flushEmbedQueue(force));
    return embedFlushQueue;
  };

  // Second pass: chunk + embed + write using global batching (parallel chunking)
  if (!dryRun) {
    await Promise.all(
      candidates.map((candidate) =>
        limit(async () => {
          try {
            const buffer = await fs.promises.readFile(candidate.filePath);
            const { chunks, indexed: didIndex } = await indexFile(
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
            pendingIndexCount = Math.max(0, pendingIndexCount - 1);
            if (didIndex) {
              indexed += 1;
              if (chunks.length > 0) {
                embedQueue.push(...chunks);
                if (embedQueue.length >= EMBED_BATCH_SIZE) {
                  await queueFlush();
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
              filePath: candidate.filePath,
            });
          } catch (_err) {
            pendingIndexCount = Math.max(0, pendingIndexCount - 1);
            onProgress?.({
              processed,
              indexed,
              total,
              filePath: candidate.filePath,
            });
          }
        }),
      ),
    );
  }

  await queueFlush(true);
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
    "utf-8",
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
