import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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

interface IndexingProfile {
  sections: Record<string, number>;
  metaFileSize?: number;
  metaSaveCount: number;
  metaSaveSkipped: boolean;
  processed: number;
  uploaded: number;
}

function now(): bigint {
  return process.hrtime.bigint();
}

function toMs(start: bigint, end?: bigint): number {
  return Number((end ?? now()) - start) / 1_000_000;
}

export class MetaStore {
  private data: Record<string, string> = {};
  private loaded = false;

  async load() {
    if (this.loaded) return;
    try {
      const content = await fs.promises.readFile(META_FILE, "utf-8");
      this.data = JSON.parse(content);
    } catch (e) {
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
  // Check if running from node_modules (published package)
  if (__dirname.includes("node_modules")) {
    return false;
  }

  // Check if NODE_ENV is set to development
  if (process.env.NODE_ENV === "development") {
    return true;
  }

  // Default to local if we can't determine
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

export async function uploadFile(
  store: Store,
  storeId: string,
  filePath: string,
  fileName: string,
  metaStore?: MetaStore,
  profile?: IndexingProfile,
  preComputedBuffer?: Buffer,
  preComputedHash?: string,
): Promise<boolean> {
  const uploadStart = PROFILE_ENABLED ? now() : null;
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
    await store.uploadFile(storeId, contentString, options);
  } catch (_err) {
    await store.uploadFile(
      storeId,
      new File([new Uint8Array(buffer)], fileName, { type: "text/plain" }),
      options,
    );
  }

  if (metaStore) {
    metaStore.set(filePath, hash);
    // We no longer save metaStore on every file to avoid O(n^2) I/O.
    // The caller (initialSync) is responsible for periodic or final saves.
  }

  if (PROFILE_ENABLED && uploadStart && profile) {
    profile.sections.upload = (profile.sections.upload ?? 0) + toMs(uploadStart);
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
        uploaded: 0,
      }
    : undefined;

  const totalStart = PROFILE_ENABLED ? now() : null;

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
          metadata && typeof metadata.hash === "string" ? metadata.hash : undefined;
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

  const fileWalkStart = PROFILE_ENABLED ? now() : null;
  const allFiles = Array.from(fileSystem.getFiles(repoRoot));
  if (PROFILE_ENABLED && fileWalkStart && profile) {
    profile.sections.fileWalk = (profile.sections.fileWalk ?? 0) + toMs(fileWalkStart);
  }
  const repoFiles = allFiles.filter(
    (filePath) => !fileSystem.isIgnored(filePath, repoRoot),
  );
  const diskPaths = new Set(repoFiles);

  // Remove records for files that no longer exist
  const stalePaths = Array.from(dbPaths).filter((p) => !diskPaths.has(p));
  if (stalePaths.length > 0) {
    const staleStart = PROFILE_ENABLED ? now() : null;
    if (dryRun) {
      stalePaths.forEach((p) => console.log("Dry run: would delete", p));
    } else {
      await Promise.all(
        stalePaths.map(async (p) => {
          try {
            await store.deleteFile(storeId, p);
            metaStore?.delete(p);
          } catch (_err) {
            // Ignore individual deletion errors to keep sync going
          }
        }),
      );
      if (metaStore) {
        await metaStore.save();
      }
    }
    if (PROFILE_ENABLED && staleStart && profile) {
      profile.sections.staleDeletes =
        (profile.sections.staleDeletes ?? 0) + toMs(staleStart);
    }
  }
  if (!dryRun && !storeIsEmpty) {
    storeIsEmpty = initialDbCount - stalePaths.length <= 0;
  }
  const total = repoFiles.length;
  let processed = 0;
  let uploaded = 0;
  if (PROFILE_ENABLED && profile) {
    profile.processed = total;
  }

  const concurrency = Math.max(1, Math.floor(os.cpus().length / 2));
  const limit = pLimit(concurrency);

  await Promise.all(
    repoFiles.map((filePath) =>
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
          const shouldUpload =
            storeIsEmpty || !existingHash || existingHash !== hash;

          if (dryRun && shouldUpload) {
            console.log("Dry run: would have uploaded", filePath);
            uploaded += 1;
          } else if (shouldUpload) {
            const didUpload = await uploadFile(
              store,
              storeId,
              filePath,
              path.basename(filePath),
              metaStore, // Pass metaStore to update it after upload
              profile,
              buffer,
              hash,
            );
            if (didUpload) {
              uploaded += 1;
              
              // Periodic meta save (every 50 uploads) to avoid data loss on crash
              // but avoid O(n^2) writes.
              if (metaStore && !SKIP_META_SAVE && uploaded % 50 === 0) {
                const saveStart = PROFILE_ENABLED ? now() : null;
                // We don't await this to avoid blocking the upload pipeline
                // It might mean concurrent saves, but that's acceptable for the meta file
                metaStore.save().catch(err => console.error("Failed to auto-save meta:", err));
                if (PROFILE_ENABLED && saveStart && profile) {
                  profile.metaSaveCount += 1;
                  profile.sections.metaSave = (profile.sections.metaSave ?? 0) + toMs(saveStart);
                }
              }
            }
          }
          onProgress?.({ processed, uploaded, total, filePath });
        } catch (_err) {
          onProgress?.({ processed, uploaded, total, filePath });
        }
      }),
    ),
  );

  if (PROFILE_ENABLED && profile) {
    profile.processed = processed;
    profile.uploaded = uploaded;
  }

  // Final meta save
  if (!dryRun && metaStore) {
    const finalSaveStart = PROFILE_ENABLED ? now() : null;
    await metaStore.save();
    if (PROFILE_ENABLED && finalSaveStart && profile) {
      profile.metaSaveCount += 1;
      profile.sections.metaSave = (profile.sections.metaSave ?? 0) + toMs(finalSaveStart);
    }
  }

  // Create/Update FTS index after sync only if changes occurred
  if (!dryRun && uploaded > 0) {
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
  } else if (!dryRun && uploaded === 0) {
    console.log("[profile] Skipping index rebuild (no uploads)");
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
        Object.entries(profile.sections).map(([k, v]) => [k, Number(v.toFixed(2))]),
      ),
    );
    console.log(
      "[profile] uploads",
      `processed=${processed} uploaded=${uploaded} metaSaves=${profile.metaSaveCount} metaSize=${metaSize ?? "n/a"} bytes`,
    );
  }

  return { processed, uploaded, total };
}
