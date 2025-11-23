export const MODEL_IDS = {
  embed: "mixedbread-ai/mxbai-embed-xsmall-v1",
  rerank: "mixedbread-ai/mxbai-rerank-xsmall-v1",
};

export const VECTOR_CACHE_MAX = Number.parseInt(
  process.env.OSGREP_VECTOR_CACHE_MAX || "10000",
  10,
);

export const WORKER_TIMEOUT_MS = Number.parseInt(
  process.env.OSGREP_WORKER_TIMEOUT_MS || "60000",
  10,
);
