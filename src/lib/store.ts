export interface FileMetadata {
  path: string;
  hash: string;
  [key: string]: any;
}

export interface ChunkType {
  type: "text" | "image_url" | "audio_url" | "video_url";
  text?: string;
  score: number;
  metadata?: FileMetadata;
  generated_metadata?: {
    start_line?: number;
    num_lines?: number;
    type?: string;
    [key: string]: any;
  };
  chunk_index?: number;
  [key: string]: any;
}

export interface StoreFile {
  external_id: string | null;
  metadata: FileMetadata | null;
}

export interface UploadFileOptions {
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
  [key: string]: any;
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
   * Upload a file to a store
   */
  uploadFile(
    storeId: string,
    file: File | ReadableStream | any,
    options: UploadFileOptions,
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
   * Ask a question to a store
   */
  ask(
    storeId: string,
    question: string,
    top_k?: number,
    search_options?: { rerank?: boolean },
    filters?: SearchFilter,
  ): Promise<AskResponse>;

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
}
