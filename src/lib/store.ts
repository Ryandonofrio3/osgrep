type MetadataPrimitive = string | number | boolean | null | undefined;
type MetadataObject = { [key: string]: MetadataValue };
type MetadataArray = MetadataValue[];
type MetadataValue = MetadataPrimitive | MetadataArray | MetadataObject;

type MetadataRecord = Record<string, MetadataValue>;

export interface FileMetadata extends MetadataRecord {
  path: string;
  hash: string;
  is_anchor?: boolean;
}

export interface ChunkGeneratedMetadata extends MetadataRecord {
  start_line?: number;
  num_lines?: number;
  type?: string;
}

export interface ChunkType extends MetadataRecord {
  type: "text" | "image_url" | "audio_url" | "video_url";
  text?: string;
  score: number;
  metadata?: FileMetadata;
  generated_metadata?: ChunkGeneratedMetadata;
  chunk_index?: number;
}

export interface StoreFile {
  external_id: string | null;
  metadata: FileMetadata | null;
}

export interface IndexFileOptions {
  external_id: string;
  overwrite?: boolean;
  metadata?: FileMetadata;
  content?: string;
}

export interface SearchResponse {
  data: ChunkType[];
}

export interface AskResponse {
  answer: string;
  sources: ChunkType[];
}

export interface CreateStoreOptions {
  name: string;
  description?: string;
}

export interface StoreInfo {
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  counts: {
    pending: number;
    in_progress: number;
  };
}

export interface SearchFilter {
  [key: string]: MetadataValue;
}

/**
 * Interface for store operations
 */
export interface Store {
  /**
   * List files in a store as an async iterator
   */
  listFiles(storeId: string): AsyncGenerator<StoreFile>;

  /**
   * Index a file in a store
   */
  indexFile(
    storeId: string,
    file: File | ReadableStream | NodeJS.ReadableStream | string,
    options: IndexFileOptions,
  ): Promise<void>;

  /**
   * Search in a store
   */
  search(
    storeId: string,
    query: string,
    top_k?: number,
    search_options?: { rerank?: boolean },
    filters?: SearchFilter,
  ): Promise<SearchResponse>;

  /**
   * Retrieve store information
   */
  retrieve(storeId: string): Promise<unknown>;

  /**
   * Create a new store
   */
  create(options: CreateStoreOptions): Promise<unknown>;

  /**
   * Get store information
   */
  getInfo(storeId: string): Promise<StoreInfo>;

  /**
   * Create FTS index
   */
  createFTSIndex(storeId: string): Promise<void>;

  /**
   * Create vector index/optimize embeddings
   */
  createVectorIndex(storeId: string): Promise<void>;

  /**
   * Delete a file and its chunks
   */
  deleteFile(storeId: string, filePath: string): Promise<void>;

  /**
   * Optional profiling data for implementations that support it
   */
  getProfile?(): unknown;

  /**
   * Optional cleanup hook for implementations that need it
   */
  close?(): Promise<void>;
}
