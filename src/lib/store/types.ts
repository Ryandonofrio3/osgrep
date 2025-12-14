type MetadataPrimitive = string | number | boolean | null | undefined;
type MetadataObject = { [key: string]: MetadataValue };
type MetadataArray = MetadataValue[];
type MetadataValue = MetadataPrimitive | MetadataArray | MetadataObject;
type MetadataRecord = Record<string, MetadataValue>;

export type PreparedChunk = {
  id: string;
  path: string;
  hash: string;
  content: string;
  start_line: number;
  end_line: number;
  chunk_index?: number;
  is_anchor?: boolean;
  context_prev?: string;
  context_next?: string;
  chunk_type?: string;
  display_text?: string;
  complexity?: number;
  is_exported?: boolean;
  defined_symbols?: string[];
  referenced_symbols?: string[];
  imports?: string[];
  exports?: string[];
  role?: string;
  parent_symbol?: string;
  file_skeleton?: string;
};

export type VectorRecord = PreparedChunk & {
  vector: Float32Array | number[];
  colbert: Int8Array | Buffer | number[];
  doc_token_ids?: number[] | Int32Array;
} & Record<string, unknown>;

export interface FileMetadata extends MetadataRecord {
  path: string;
  hash: string;
  is_anchor?: boolean;
}

export interface ChunkGeneratedMetadata extends MetadataRecord {
  start_line?: number;
  end_line?: number;
  num_lines?: number;
  type?: string;
}

export interface ChunkType extends MetadataRecord {
  type: "text" | "image_url" | "audio_url" | "video_url";
  text?: string;
  score: number;
  confidence?: "High" | "Medium" | "Low";
  metadata?: FileMetadata;
  generated_metadata?: ChunkGeneratedMetadata;
  chunk_index?: number;
  complexity?: number;
  is_exported?: boolean;
  defined_symbols?: string[];
  referenced_symbols?: string[];
  imports?: string[];
  exports?: string[];
  role?: string;
  parent_symbol?: string;
  context?: string[];
}

export interface SearchResponse {
  data: ChunkType[];
}

export interface SearchFilter {
  [key: string]: MetadataValue;
}
