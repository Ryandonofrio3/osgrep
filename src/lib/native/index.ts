

import { CONFIG, MODEL_IDS } from "../../config";

// Try to load native binding
let native: typeof import("osgrep-core") | null = null;
let initPromise: Promise<void> | null = null;
let initialized = false;

async function loadNative() {
  if (native) return native;

  try {
    native = await import("osgrep-core");
  } catch (e) {
    throw new Error(
      `Failed to load osgrep-core native binding. Run 'npm run build:release' in osgrep/osgrep-core/: ${e}`
    );
  }

  return native;
}

/**
 * Initialize native models. Call once at startup.
 */
export async function initNative(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const n = await loadNative();

    if (!n.isInitialized()) {
      n.initModels(MODEL_IDS.embed, MODEL_IDS.colbert);
    }

    initialized = true;
  })().finally(() => {
    initPromise = null;
  });

  return initPromise;
}

/**
 * Check if native models are initialized
 */
export function isNativeInitialized(): boolean {
  return initialized && native?.isInitialized() === true;
}

// =============================================================================
// Dense Embeddings
// =============================================================================

export interface DenseEmbedding {
  vector: Float32Array;
}

/**
 * Embed texts to dense vectors (384-dim, L2-normalized)
 */
export async function embedDense(texts: string[]): Promise<Float32Array[]> {
  await initNative();
  const n = await loadNative();

  const result = n.embedDense(texts);
  const dim = CONFIG.VECTOR_DIM;

  // Split flat array into per-text vectors
  const vectors: Float32Array[] = [];
  for (let i = 0; i < result.count; i++) {
    const start = i * dim;
    const vec = new Float32Array(dim);
    for (let j = 0; j < dim; j++) {
      vec[j] = result.embeddings[start + j];
    }
    vectors.push(vec);
  }

  return vectors;
}

// =============================================================================
// ColBERT Embeddings (for indexing)
// =============================================================================

export interface ColbertPacked {
  /** Quantized embeddings as Int8Array */
  embeddings: Int8Array;
  /** Number of tokens per document */
  lengths: Uint32Array;
  /** Byte offsets for each document */
  offsets: Uint32Array;
}

/**
 * Embed texts to ColBERT format (48-dim per token, INT8 quantized)
 * Use at INDEX TIME to pre-compute embeddings
 */
export async function embedColbert(texts: string[]): Promise<ColbertPacked> {
  await initNative();
  const n = await loadNative();

  const result = n.embedColbertPacked(texts);

  return {
    embeddings: new Int8Array(result.embeddings),
    lengths: new Uint32Array(result.lengths),
    offsets: new Uint32Array(result.offsets),
  };
}

// =============================================================================
// Combined Embedding (for indexing)
// =============================================================================

export interface HybridEmbedding {
  dense: Float32Array;
  colbert: Int8Array;
  token_ids: Uint32Array;
  colbertLength: number;
  colbertOffset: number;
}

/**
 * Embed texts for indexing (both dense and ColBERT in one call)
 * Returns per-text embeddings ready for storage
 */
export async function embedBatch(texts: string[]): Promise<HybridEmbedding[]> {
  await initNative();
  const n = await loadNative();

  const result = n.embedBatch(texts);
  const dim = CONFIG.VECTOR_DIM;
  const colbertDim = CONFIG.COLBERT_DIM;

  const embeddings: HybridEmbedding[] = [];
  const tokenIds = new Uint32Array(result.colbertTokenIds);
  let tokenCursor = 0;

  for (let i = 0; i < texts.length; i++) {
    // Extract dense vector
    const denseStart = i * dim;
    const dense = new Float32Array(dim);
    for (let j = 0; j < dim; j++) {
      dense[j] = result.dense[denseStart + j];
    }

    // Extract ColBERT embedding for this doc
    const colbertOffset = result.colbertOffsets[i];
    const colbertLength = result.colbertLengths[i];
    const colbertSize = colbertLength * colbertDim;
    const colbert = new Int8Array(colbertSize);
    for (let j = 0; j < colbertSize; j++) {
      colbert[j] = result.colbertEmbeddings[colbertOffset + j];
    }

    // Extract token IDs for this doc (length = colbertLength)
    const tokenSlice = tokenIds.subarray(tokenCursor, tokenCursor + colbertLength);
    tokenCursor += colbertLength;

    embeddings.push({
      dense,
      colbert,
      token_ids: new Uint32Array(tokenSlice),
      colbertLength,
      colbertOffset: 0, // Will be set when storing
    });
  }

  return embeddings;
}

// =============================================================================
// ColBERT Query Encoding
// =============================================================================

/**
 * Encode query for ColBERT reranking
 * Returns query embedding matrix as Float32Array
 */
export async function encodeQueryColbert(query: string): Promise<Float32Array> {
  await initNative();
  const n = await loadNative();

  const result = n.encodeQueryColbert(query);
  return new Float32Array(result);
}

// =============================================================================
// ColBERT Reranking
// =============================================================================

export interface RerankInput {
  /** Query ColBERT embedding from encodeQueryColbert */
  queryEmbedding: Float32Array;
  /** Packed ColBERT doc embeddings (INT8) */
  docEmbeddings: Int8Array;
  /** Packed ColBERT doc token ids (UINT32) aligned to docEmbeddings */
  docTokenIds: Uint32Array;
  /** Token counts per doc */
  docLengths: number[];
  /** Byte offsets per doc */
  docOffsets: number[];
  /** Which doc indices to rerank */
  candidateIndices: number[];
  /** How many to return */
  topK: number;
}

export interface RerankResult {
  /** Original indices of top-k docs */
  indices: number[];
  /** MaxSim scores */
  scores: number[];
}

/**
 * Rerank documents using pre-indexed ColBERT embeddings
 */
export async function rerankColbert(input: RerankInput): Promise<RerankResult> {
  await initNative();
  const n = await loadNative();

  const q = Float64Array.from(input.queryEmbedding as any);

  const docs =
    input.docEmbeddings instanceof Int8Array
      ? input.docEmbeddings
      : new Int8Array(input.docEmbeddings as any);

  const tokenIds =
    input.docTokenIds instanceof Uint32Array
      ? input.docTokenIds
      : Uint32Array.from(input.docTokenIds as any);

  const result = n.rerankColbert(
    q,
    docs,
    tokenIds,
    input.docLengths,
    input.docOffsets,
    input.candidateIndices,
    input.topK
  );

  return {
    indices: Array.from(result.indices),
    scores: Array.from(result.scores),
  };
}
