import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { extname } from "node:path";

// Extensions we consider for indexing to avoid binary noise and improve relevance.
const INDEXABLE_EXTENSIONS = new Set([
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

export function computeFileHash(
    filePath: string,
    readFileSyncFn: (p: string) => Buffer,
): string {
    const buffer = readFileSyncFn(filePath);
    return computeBufferHash(buffer);
}

// Check if a file should be indexed (extension and size).
export function isIndexableFile(filePath: string, size?: number): boolean {
    const ext = extname(filePath).toLowerCase();
    const basename = path.basename(filePath).toLowerCase();
    if (!INDEXABLE_EXTENSIONS.has(ext) && !INDEXABLE_EXTENSIONS.has(basename)) {
        return false;
    }

    const withinSize = (s: number) =>
        s > 0 && s <= MAX_FILE_SIZE_BYTES;

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
