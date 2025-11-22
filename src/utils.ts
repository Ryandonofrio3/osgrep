import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extname } from "node:path";
import pLimit from "p-limit";
import type { FileSystem } from "./lib/file";
import type { Store } from "./lib/store";
import type {
  InitialSyncProgress,
  InitialSyncResult,
} from "./lib/sync-helpers";

const META_FILE = path.join(os.homedir(), ".osgrep", "meta.json");
const PROFILE_ENABLED =
  process.env.OSGREP_PROFILE === "1" || process.env.OSGREP_PROFILE === "true";
const SKIP_META_SAVE =
  process.env.OSGREP_SKIP_META_SAVE === "1" ||
  process.env.OSGREP_SKIP_META_SAVE === "true";

// --- THE VELVET ROPE CONFIGURATION ---
// Only index these extensions to avoid binary noise and improve relevance.
const INDEXABLE_EXTENSIONS = new Set([
  // Code
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
  ".rb", ".php", ".cs", ".swift", ".kt", ".scala", ".lua", ".sh", ".sql", ".html", ".css",
  ".dart", ".el", ".clj", ".ex", ".exs", ".m", ".mm", ".f90", ".f95",
  // Config / Data / Docs
  ".json", ".yaml", ".yml", ".toml", ".xml", ".md", ".mdx", ".txt", ".env", ".gitignore",
  ".dockerfile", "dockerfile", "makefile"
]);

const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB limit for semantic indexing

interface IndexingProfile {
  sections: Record<string, number>;
  metaFileSize?: number;
  metaSaveCount: number;
  metaSaveSkipped: boolean;
  processed: number;
  indexed: number;
}

function now(): bigint {
  return process.hrtime.bigint();
}

function toMs(start: bigint, end?: bigint): number {
  return Number((end ?? now()) - start) / 1_000_000;
}

/**
 * Checks if a file is worthy of being indexed (semantic relevance + size safety)
 */
function isIndexableFile(filePath: string): boolean {
  // 1. Extension Check
  const ext = extname(filePath).toLowerCase();
  // Special handling for files like Dockerfile or Makefile that might have no ext
  const basename = path.basename(filePath).toLowerCase();
  if (!INDEXABLE_EXTENSIONS.has(ext) && !INDEXABLE_EXTENSIONS.has(basename)) {
    return false;
  }

  // 2. Size Check (Skip huge files that choke the embedder)
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_FILE_SIZE_BYTES) return false;
    if (stats.size === 0) return false; // Skip empty files
  } catch {
    return false;
  }

  return true;
}

export class MetaStore {
  private data: Record<string, string> = {};
  private loaded = false;

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
    await fs.promises.mkdir(path.dirname(META_FILE), { recursive: true });
    await fs.promises.writeFile(META_FILE, JSON.stringify(this.data, null, 2));
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
  if (__dirname.includes("node_modules")) {
    return false;
  }
  if (process.env.NODE_ENV === "development") {
    return true;
  }
  return true;
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
): Promise<boolean> {
  const indexStart = PROFILE_ENABLED ? now() : null;
  let buffer: Buffer;
  let hash: string;

  if (preComputedBuffer && preComputedHash) {
    buffer = preComputedBuffer;
    hash = preComputedHash;
  } else {
    buffer = await fs.promises.readFile(filePath);
    if (buffer.length === 0) {
      return false;
    }
    hash = computeBufferHash(buffer);
  }

  const contentString = buffer.toString("utf-8");

  if (metaStore) {
    const cachedHash = metaStore.get(filePath);
    if (cachedHash === hash) {
      return false;
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

  try {
    await store.indexFile(storeId, contentString, options);
  } catch (_err) {
    // Fallback for weird encodings
    await store.indexFile(
      storeId,
      new File([new Uint8Array(buffer)], fileName, { type: "text/plain" }),
      options,
    );
  }

  if (metaStore) {
    metaStore.set(filePath, hash);
  }

  if (PROFILE_ENABLED && indexStart && profile) {
    profile.sections.index = (profile.sections.index ?? 0) + toMs(indexStart);
  }

  return true;
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
    profile.sections.storeScan = (profile.sections.storeScan ?? 0) + toMs(storeScanStart);
  }

  if (metaStore && storeHashes.size === 0) {
    storeHashes = new Map();
  }

  // 2. Walk file system and apply the VELVET ROPE filter
  const fileWalkStart = PROFILE_ENABLED ? now() : null;
  const allFiles = Array.from(fileSystem.getFiles(repoRoot));
  
  if (PROFILE_ENABLED && fileWalkStart && profile) {
    profile.sections.fileWalk = (profile.sections.fileWalk ?? 0) + toMs(fileWalkStart);
  }

  const repoFiles = allFiles.filter(
    (filePath) => 
      !fileSystem.isIgnored(filePath, repoRoot) && 
      isIndexableFile(filePath) // <--- New semantic noise filter
  );
  
  const diskPaths = new Set(repoFiles);

  // 3. Delete stale files (files in DB but not on disk)
  const stalePaths = Array.from(dbPaths).filter((p) => !diskPaths.has(p));
  if (stalePaths.length > 0) {
    const staleStart = PROFILE_ENABLED ? now() : null;
    if (dryRun) {
      for (const p of stalePaths) {
        console.log("Dry run: would delete", p);
      }
    } else {
      await Promise.all(
        stalePaths.map(async (p) => {
          try {
            await store.deleteFile(storeId, p);
            metaStore?.delete(p);
          } catch (_err) {
            // Ignore individual deletion errors
          }
        }),
      );
      if (metaStore) {
        await metaStore.save();
      }
    }
    if (PROFILE_ENABLED && staleStart && profile) {
      profile.sections.staleDeletes = (profile.sections.staleDeletes ?? 0) + toMs(staleStart);
    }
  }

  if (!dryRun && !storeIsEmpty) {
    storeIsEmpty = initialDbCount - stalePaths.length <= 0;
  }

  const total = repoFiles.length;
  let processed = 0;
  let indexed = 0;
  
  if (PROFILE_ENABLED && profile) {
    profile.processed = total;
  }

  // --- ADAPTIVE PACING CONFIGURATION ---
  const MIN_CONCURRENCY = 1;
  const MAX_CONCURRENCY = Math.max(1, Math.floor(os.cpus().length / 2));
  let currentConcurrency = Math.max(1, Math.floor(MAX_CONCURRENCY / 1.5));
  const BATCH_SIZE = 10; // Process in small chunks to allow breathing room

  // Process files in batches
  for (let i = 0; i < repoFiles.length; i += BATCH_SIZE) {
    const batch = repoFiles.slice(i, i + BATCH_SIZE);
    const batchStart = Date.now();

    // Re-create limiter based on dynamic concurrency
    const limit = pLimit(currentConcurrency);

    await Promise.all(
      batch.map((filePath) =>
        limit(async () => {
          try {
            const buffer = await fs.promises.readFile(filePath);
            const hashStart = PROFILE_ENABLED ? now() : null;
            const hash = computeBufferHash(buffer);
            
            if (PROFILE_ENABLED && hashStart && profile) {
              profile.sections.hash = (profile.sections.hash ?? 0) + toMs(hashStart);
            }

            let existingHash: string | undefined;
            if (metaStore) {
              existingHash = metaStore.get(filePath);
            } else {
              existingHash = storeHashes.get(filePath);
            }

            processed += 1;
            const shouldIndex = storeIsEmpty || !existingHash || existingHash !== hash;

            if (dryRun && shouldIndex) {
              // console.log("Dry run: would have indexed", filePath); // Keep output clean
              indexed += 1;
            } else if (shouldIndex) {
              const didIndex = await indexFile(
                store,
                storeId,
                filePath,
                path.basename(filePath),
                metaStore,
                profile,
                buffer,
                hash,
              );
              if (didIndex) {
                indexed += 1;

                // Periodic meta save
                if (metaStore && !SKIP_META_SAVE && indexed % 25 === 0) {
                  const saveStart = PROFILE_ENABLED ? now() : null;
                  metaStore.save().catch((err) =>
                    console.error("Failed to auto-save meta:", err),
                  );
                  if (PROFILE_ENABLED && saveStart && profile) {
                    profile.metaSaveCount += 1;
                    profile.sections.metaSave = (profile.sections.metaSave ?? 0) + toMs(saveStart);
                  }
                }
              }
            }
            onProgress?.({ processed, indexed, total, filePath });
          } catch (_err) {
            onProgress?.({ processed, indexed, total, filePath });
          }
        })
      )
    );

    // --- THE THERMOSTAT ---
    // Monitor performance and health after every batch
    const batchDuration = Date.now() - batchStart;
    const timePerFile = batchDuration / batch.length;
    const memUsageMB = process.memoryUsage().rss / 1024 / 1024;

    // Case 1: Getting too hot (Memory spike or very slow processing)
    if (memUsageMB > 1500) { 
       // If RSS > 1.5GB, clamp down hard and sleep
       currentConcurrency = Math.max(MIN_CONCURRENCY, currentConcurrency - 2);
       // Force a pause to let GC run/system breathe
       await new Promise(resolve => setTimeout(resolve, 1000)); 
    } 
    else if (timePerFile > 300) { 
       // Taking >300ms per file means embedding/hashing is struggling
       currentConcurrency = Math.max(MIN_CONCURRENCY, currentConcurrency - 1);
    } 
    // Case 2: Cruising comfortably
    else if (timePerFile < 80 && currentConcurrency < MAX_CONCURRENCY) {
       // If we are fast (<80ms/file), we can afford more concurrency
       currentConcurrency++;
    }
  }

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
  } else if (!dryRun && indexed === 0) {
    // console.log("[profile] Skipping index rebuild (no new files)");
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