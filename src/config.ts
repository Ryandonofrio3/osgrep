import * as os from "node:os";
export const MODEL_IDS = {
  embed: "onnx-community/granite-embedding-30m-english-ONNX",
  colbert: "ryandono/osgrep-colbert-q8",
};

export const CONFIG = {
  VECTOR_DIMENSIONS: 384,
  COLBERT_DIM: 48,
  QUERY_PREFIX: "",
};

export const WORKER_TIMEOUT_MS = Number.parseInt(
  process.env.OSGREP_WORKER_TIMEOUT_MS || "60000",
  10,
);

export const WORKER_BOOT_TIMEOUT_MS = Number.parseInt(
  process.env.OSGREP_WORKER_BOOT_TIMEOUT_MS || "300000",
  10,
);

export const MAX_WORKER_MEMORY_MB = Number.parseInt(
  process.env.OSGREP_MAX_WORKER_MEMORY_MB ||
  String(
    Math.max(
      2048,
      Math.floor((os.totalmem() / 1024 / 1024) * 0.5), // 50% of system RAM
    ),
  ),
  10,
);
