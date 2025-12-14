/**
 * Orchestrator: Coordinates file processing and embedding
 *
 * This module handles:
 * - File reading and validation
 * - Chunking via tree-sitter
 * - Embedding via native Rust code
 *
 * No worker pool needed - Rust ONNX Runtime is fast and stable.
 */

import * as path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { CONFIG } from "../../config";
import {
  buildAnchorChunk,
  type ChunkWithContext,
  formatChunkText,
  TreeSitterChunker,
} from "../index/chunker";
import { embedBatch, initNative, encodeQueryColbert, rerankColbert } from "../native";
import type { PreparedChunk, VectorRecord } from "../store/types";
import {
  computeBufferHash,
  hasNullByte,
  isIndexableFile,
  readFileSnapshot,
} from "../utils/file-utils";

// =============================================================================
// Types
// =============================================================================

export type ProcessFileInput = {
  path: string;
  absolutePath?: string;
};

export type ProcessFileResult = {
  vectors: VectorRecord[];
  hash: string;
  mtimeMs: number;
  size: number;
  shouldDelete?: boolean;
};

export type RerankDoc = {
  colbert: Buffer | Int8Array | number[];
  token_ids?: number[];
};

// =============================================================================
// Orchestrator
// =============================================================================

const PROJECT_ROOT = process.env.OSGREP_PROJECT_ROOT
  ? path.resolve(process.env.OSGREP_PROJECT_ROOT)
  : process.cwd();

export class WorkerOrchestrator {
  private chunker = new TreeSitterChunker();
  private initPromise: Promise<void> | null = null;

  private async ensureReady() {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await Promise.all([this.chunker.init(), initNative()]);
    })().finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  private async chunkFile(
    pathname: string,
    content: string
  ): Promise<ChunkWithContext[]> {
    await this.ensureReady();
    const { chunks: parsedChunks, metadata } = await this.chunker.chunk(
      pathname,
      content
    );

    const anchorChunk = buildAnchorChunk(pathname, content, metadata);
    const baseChunks = anchorChunk
      ? [anchorChunk, ...parsedChunks]
      : parsedChunks;

    return baseChunks.map((chunk, idx) => {
      const chunkWithContext = chunk as ChunkWithContext;
      return {
        ...chunkWithContext,
        context: Array.isArray(chunkWithContext.context)
          ? chunkWithContext.context
          : [],
        chunkIndex:
          typeof chunkWithContext.chunkIndex === "number"
            ? chunkWithContext.chunkIndex
            : anchorChunk
              ? idx - 1
              : idx,
        isAnchor:
          chunkWithContext.isAnchor === true ||
          (anchorChunk ? idx === 0 : false),
        imports: metadata.imports,
      };
    });
  }

  private toPreparedChunks(
    filePath: string,
    hash: string,
    chunks: ChunkWithContext[]
  ): PreparedChunk[] {
    const texts = chunks.map((chunk) => formatChunkText(chunk, filePath));
    const prepared: PreparedChunk[] = [];

    for (let i = 0; i < texts.length; i++) {
      const chunk = chunks[i];
      const { content, displayText } = texts[i];
      const prev = texts[i - 1]?.displayText;
      const next = texts[i + 1]?.displayText;

      prepared.push({
        id: uuidv4(),
        path: filePath,
        hash,
        content,
        display_text: displayText,
        context_prev: typeof prev === "string" ? prev : undefined,
        context_next: typeof next === "string" ? next : undefined,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        chunk_index: chunk.chunkIndex,
        is_anchor: chunk.isAnchor === true,
        chunk_type: typeof chunk.type === "string" ? chunk.type : undefined,
        complexity: chunk.complexity,
        is_exported: chunk.isExported,
        defined_symbols: chunk.definedSymbols,
        referenced_symbols: chunk.referencedSymbols,
        role: chunk.role,
        parent_symbol: chunk.parentSymbol,
      });
    }

    return prepared;
  }

  async processFile(
    input: ProcessFileInput,
    onProgress?: () => void
  ): Promise<ProcessFileResult> {
    const absolutePath = path.isAbsolute(input.path)
      ? input.path
      : input.absolutePath
        ? input.absolutePath
        : path.join(PROJECT_ROOT, input.path);

    const { buffer, mtimeMs, size } = await readFileSnapshot(absolutePath);
    const hash = computeBufferHash(buffer);

    if (!isIndexableFile(absolutePath, size)) {
      return { vectors: [], hash, mtimeMs, size, shouldDelete: true };
    }

    if (buffer.length === 0 || hasNullByte(buffer)) {
      return { vectors: [], hash, mtimeMs, size, shouldDelete: true };
    }

    onProgress?.();
    await this.ensureReady();
    onProgress?.();

    const content = buffer.toString("utf-8");
    const chunks = await this.chunkFile(input.path, content);
    onProgress?.();

    if (!chunks.length) return { vectors: [], hash, mtimeMs, size };

    const preparedChunks = this.toPreparedChunks(input.path, hash, chunks);

    // Embed all chunks via native Rust
    const hybrids = await embedBatch(
      preparedChunks.map((chunk) => chunk.content)
    );
    onProgress?.();

    const vectors: VectorRecord[] = preparedChunks.map((chunk, idx) => {
      const hybrid = hybrids[idx];
      return {
        ...chunk,
        vector: hybrid.dense,
        colbert: Buffer.from(hybrid.colbert),
        doc_token_ids: Array.from(hybrid.token_ids),
      };
    });

    onProgress?.();
    return { vectors, hash, mtimeMs, size };
  }

  async encodeQuery(text: string): Promise<{
    dense: number[];
    colbert: number[][];
    colbertDim: number;
  }> {
    await this.ensureReady();

    // Get dense embedding
    const hybrids = await embedBatch([text]);
    const denseVector = hybrids[0].dense;

    // Get ColBERT query embedding
    const colbertFlat = await encodeQueryColbert(text);
    const dim = CONFIG.COLBERT_DIM;
    const seqLen = colbertFlat.length / dim;

    // Reshape to matrix
    const matrix: number[][] = [];
    for (let s = 0; s < seqLen; s++) {
      const row: number[] = [];
      for (let d = 0; d < dim; d++) {
        row.push(colbertFlat[s * dim + d]);
      }
      matrix.push(row);
    }

    return {
      dense: Array.from(denseVector),
      colbert: matrix,
      colbertDim: dim,
    };
  }

  async rerank(input: {
    query: number[][];
    docs: RerankDoc[];
    colbertDim: number;
  }): Promise<number[]> {
    await this.ensureReady();

    // Flatten query matrix to match native `rerankColbert` signature
    const queryEmbedding: number[] = [];
    for (const row of input.query) {
      for (let i = 0; i < row.length; i++) {
        queryEmbedding.push(row[i] ?? 0);
      }
    }

    const docLengths: number[] = [];
    const docOffsets: number[] = [];
    const candidateIndices: number[] = [];
    const packedTokenChunks: Uint32Array[] = [];

    // Pack all doc embeddings into a single buffer; offsets are element offsets
    const packedChunks: Int8Array[] = [];
    let totalElements = 0;
    let totalTokenIds = 0;

    for (let i = 0; i < input.docs.length; i++) {
      const doc = input.docs[i];
      const col = doc.colbert;

      let colbert: Int8Array;
      if (col instanceof Int8Array) {
        colbert = col;
      } else if (Buffer.isBuffer(col)) {
        colbert = new Int8Array(col.buffer, col.byteOffset, col.byteLength);
      } else if (Array.isArray(col)) {
        colbert = new Int8Array(col);
      } else {
        colbert = new Int8Array(0);
      }

      const seqLen = Math.floor(colbert.length / input.colbertDim);
      const used = colbert.subarray(0, seqLen * input.colbertDim);

      const tokenIdsRaw = doc.token_ids ?? [];
      const tokenIds = Uint32Array.from(
        tokenIdsRaw.slice(0, seqLen).map((v) => (Number.isFinite(v) ? v : 0)),
      );

      docOffsets.push(totalElements);
      docLengths.push(seqLen);
      candidateIndices.push(i);
      packedChunks.push(used);
      packedTokenChunks.push(tokenIds);
      totalElements += used.length;
      totalTokenIds += tokenIds.length;
    }

    const packed = new Int8Array(totalElements);
    let cursor = 0;
    for (const chunk of packedChunks) {
      packed.set(chunk, cursor);
      cursor += chunk.length;
    }

    const packedTokenIds = new Uint32Array(totalTokenIds);
    let tokenCursor = 0;
    for (const chunk of packedTokenChunks) {
      packedTokenIds.set(chunk, tokenCursor);
      tokenCursor += chunk.length;
    }

    const result = await rerankColbert({
      queryEmbedding: new Float32Array(queryEmbedding),
      docEmbeddings: packed,
      docTokenIds: packedTokenIds,
      docLengths,
      docOffsets,
      candidateIndices,
      topK: input.docs.length,
    });

    const scoreByIndex = new Map<number, number>();
    for (let i = 0; i < result.indices.length; i++) {
      const idx = result.indices[i] ?? -1;
      const score = result.scores[i] ?? 0;
      if (typeof idx === "number") scoreByIndex.set(idx, score);
    }

    // Return scores aligned to input order (Searcher expects this)
    return candidateIndices.map((i) => scoreByIndex.get(i) ?? 0);
  }
}

// =============================================================================
// Singleton for direct use (no worker pool needed)
// =============================================================================

let orchestrator: WorkerOrchestrator | null = null;

export function getOrchestrator(): WorkerOrchestrator {
  if (!orchestrator) {
    orchestrator = new WorkerOrchestrator();
  }
  return orchestrator;
}

export async function processFile(
  input: ProcessFileInput
): Promise<ProcessFileResult> {
  return getOrchestrator().processFile(input);
}

export async function encodeQuery(text: string) {
  return getOrchestrator().encodeQuery(text);
}

export async function rerank(input: {
  query: number[][];
  docs: RerankDoc[];
  colbertDim: number;
}) {
  return getOrchestrator().rerank(input);
}
