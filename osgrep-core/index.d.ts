// TypeScript declarations for the `osgrep-core` native module (N-API).

export interface DenseResult {
  /** Flat array of embeddings [batch_size * 384] */
  embeddings: number[];
  /** Number of texts encoded */
  count: number;
}

export interface ColbertPackedResult {
  /** Packed embeddings as flat i8 array (all docs concatenated) */
  embeddings: Int8Array | number[];
  /** Token IDs for skiplist filtering */
  tokenIds: Uint32Array | number[];
  /** Number of tokens per document */
  lengths: Uint32Array | number[];
  /** Byte offsets into embeddings for each doc */
  offsets: Uint32Array | number[];
}

export interface RerankResult {
  /** Original indices of top-k documents */
  indices: number[];
  /** MaxSim scores for top-k documents */
  scores: number[];
}

export interface EmbedResult {
  /** Dense embeddings [batch_size * 384] */
  dense: number[];
  /** Packed ColBERT embeddings (i8) */
  colbertEmbeddings: Int8Array | number[];
  /** Token IDs for skiplist filtering (all docs concatenated) */
  colbertTokenIds: Uint32Array | number[];
  /** Token counts per document */
  colbertLengths: Uint32Array | number[];
  /** Byte offsets per document */
  colbertOffsets: Uint32Array | number[];
}

export function initModels(denseRepo: string, colbertRepo: string): void;
export function isInitialized(): boolean;

export function embedDense(texts: string[]): DenseResult;
export function embedColbertPacked(texts: string[]): ColbertPackedResult;

/** Returns query embeddings as a flat array [seq_len * 48]. */
export function encodeQueryColbert(query: string): Float64Array | number[];

export function rerankColbert(
  queryEmbeddings: Float64Array | number[],
  docEmbeddings: Int8Array | number[],
  docTokenIds: Uint32Array | number[],
  docLengths: number[] | Uint32Array,
  docOffsets: number[] | Uint32Array,
  candidateIndices: number[] | Uint32Array,
  topK: number,
): RerankResult;

export function embedBatch(texts: string[]): EmbedResult;
