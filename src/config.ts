import * as os from "node:os";
import * as path from "node:path";

export const MODEL_IDS = {
  embed: "onnx-community/granite-embedding-30m-english-ONNX",
  colbert: "ryandono/osgrep-colbert-q8",
};

const DEFAULT_WORKER_THREADS = (() => {
  const fromEnv = Number.parseInt(process.env.OSGREP_WORKER_THREADS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const cores = os.cpus().length || 1;
  const isAppleSilicon = process.platform === "darwin" && process.arch === "arm64";
  if (isAppleSilicon) {
    return Math.max(1, Math.floor(cores / 2));
  }
  return Math.max(1, cores);
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

export const WORKER_TIMEOUT_MS = Number.parseInt(
  process.env.OSGREP_WORKER_TIMEOUT_MS || "60000",
  10,
);

const HOME = os.homedir();
const GLOBAL_ROOT = path.join(HOME, ".osgrep");

export const PATHS = {
  globalRoot: GLOBAL_ROOT,
  models: path.join(GLOBAL_ROOT, "models"),
  grammars: path.join(GLOBAL_ROOT, "grammars"),
};
