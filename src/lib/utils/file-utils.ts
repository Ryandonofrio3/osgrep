import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { extname } from "node:path";
import { INDEXABLE_EXTENSIONS, MAX_FILE_SIZE_BYTES } from "../../config";

export function computeBufferHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function hasNullByte(buffer: Buffer, sampleLength = 1024): boolean {
  const length = Math.min(buffer.length, sampleLength);
  for (let i = 0; i < length; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export async function readFileSnapshot(
  filePath: string,
): Promise<{ buffer: Buffer; mtimeMs: number; size: number }> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const before = await handle.stat();
    if (before.size > MAX_FILE_SIZE_BYTES) {
      throw new Error("File exceeds maximum allowed size");
    }
    const size = before.size;
    const buffer = size > 0 ? Buffer.allocUnsafe(size) : Buffer.alloc(0);
    if (size > 0) {
      await handle.read(buffer, 0, size, 0);
    }
    const after = await handle.stat();
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
      throw new Error("File changed during read");
    }
    return { buffer, mtimeMs: after.mtimeMs, size: after.size };
  } finally {
    await handle.close();
  }
}

// Check if a file should be indexed (extension and size).
export function isIndexableFile(filePath: string, size?: number): boolean {
  const ext = extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  if (!INDEXABLE_EXTENSIONS.has(ext) && !INDEXABLE_EXTENSIONS.has(basename)) {
    return false;
  }

  const withinSize = (s: number) => s > 0 && s <= MAX_FILE_SIZE_BYTES;

  if (typeof size === "number") {
    return withinSize(size);
  }

  try {
    const stats = fs.statSync(filePath);
    return withinSize(stats.size);
  } catch {
    return false;
  }
}

export function isIndexablePath(filePath: string): boolean {
  return isIndexableFile(filePath);
}

export function formatDenseSnippet(text: string, maxLength = 1500): string {
  const clean = text ?? "";
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}...`;
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
