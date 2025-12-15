import * as os from "node:os";
import * as path from "node:path";

export const MODEL_IDS = {
  embed: "onnx-community/granite-embedding-30m-english-ONNX",
  colbert: "ryandono/mxbai-edge-colbert-v0-17m-onnx-int8",
};

const DEFAULT_WORKER_THREADS = (() => {
  const fromEnv = Number.parseInt(process.env.OSGREP_WORKER_THREADS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;

  const cores = os.cpus().length || 1;
  const HARD_CAP = 4;
  return Math.max(1, Math.min(HARD_CAP, cores));
})();

export const CONFIG = {
  VECTOR_DIM: 384,
  COLBERT_DIM: 48,
  MAX_CHUNK_CHARS: 2000,
  MAX_CHUNK_LINES: 75,
  EMBED_BATCH_SIZE: 24,
  WORKER_THREADS: DEFAULT_WORKER_THREADS,
  QUERY_PREFIX: "",
};

const HOME = os.homedir();
const GLOBAL_ROOT = path.join(HOME, ".osgrep");

export const PATHS = {
  globalRoot: GLOBAL_ROOT,
  grammars: path.join(GLOBAL_ROOT, "grammars"),
};

export const MAX_FILE_SIZE_BYTES = 1024 * 1024 * 2; // 2MB limit for indexing

// Extensions we consider for indexing to avoid binary noise and improve relevance.
export const INDEXABLE_EXTENSIONS: Set<string> = new Set([
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
