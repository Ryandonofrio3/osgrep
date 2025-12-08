import * as fs from "node:fs";
import * as path from "node:path";
import { env } from "@huggingface/transformers";
import * as ort from "onnxruntime-node";
import { v4 as uuidv4 } from "uuid";
import { CONFIG, PATHS } from "../../config";
import {
  buildAnchorChunk,
  type ChunkWithContext,
  formatChunkText,
  TreeSitterChunker,
} from "../index/chunker";
import type { PreparedChunk, VectorRecord } from "../store/types";
import {
  computeBufferHash,
  hasNullByte,
  isIndexableFile,
  readFileSnapshot,
} from "../utils/file-utils";
import { maxSim } from "./colbert-math";
import { ColbertModel, type HybridResult } from "./embeddings/colbert";
import { GraniteModel } from "./embeddings/granite";

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
  scale: number;
  token_ids?: number[];
};

const CACHE_DIR = PATHS.models;
const LOG_MODELS =
  process.env.OSGREP_DEBUG_MODELS === "1" ||
  process.env.OSGREP_DEBUG_MODELS === "true";
const log = (...args: unknown[]) => {
  if (LOG_MODELS) console.log(...args);
};

env.cacheDir = CACHE_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = true;

const PROJECT_ROOT = process.env.OSGREP_PROJECT_ROOT
  ? path.resolve(process.env.OSGREP_PROJECT_ROOT)
  : process.cwd();
const LOCAL_MODELS = path.join(PROJECT_ROOT, "models");
if (fs.existsSync(LOCAL_MODELS)) {
  env.localModelPath = LOCAL_MODELS;
  log(`Worker: Using local models from ${LOCAL_MODELS}`);
}

export class WorkerOrchestrator {
  private granite = new GraniteModel();
  private colbert = new ColbertModel();
  private chunker = new TreeSitterChunker();
  private initPromise: Promise<void> | null = null;
  private readonly vectorDimensions = CONFIG.VECTOR_DIM;

  private async ensureReady() {
    if (this.granite.isReady() && this.colbert.isReady()) {
      return;
    }
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await Promise.all([
        this.chunker.init(),
        this.granite.load(),
        this.colbert.load(),
      ]);
    })().finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  private async computeHybrid(
    texts: string[],
    onProgress?: () => void,
  ): Promise<HybridResult[]> {
    if (!texts.length) return [];
    await this.ensureReady();

    const results: HybridResult[] = [];
    const envBatch = Number.parseInt(
      process.env.OSGREP_WORKER_BATCH_SIZE ?? "",
      10,
    );
    const BATCH_SIZE =
      Number.isFinite(envBatch) && envBatch > 0
        ? Math.max(4, Math.min(16, envBatch))
        : 16;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      if (i > 0) onProgress?.();
      const batchTexts = texts.slice(i, i + BATCH_SIZE);
      const denseBatch = await this.granite.runBatch(batchTexts);
      const colbertBatch = await this.colbert.runBatch(
        batchTexts,
        denseBatch,
        this.vectorDimensions,
      );
      results.push(...colbertBatch);
    }
    onProgress?.();

    return results;
  }

  private async chunkFile(
    pathname: string,
    content: string,
  ): Promise<ChunkWithContext[]> {
    await this.ensureReady();
    const { chunks: parsedChunks, metadata } = await this.chunker.chunk(
      pathname,
      content,
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
    path: string,
    hash: string,
    chunks: ChunkWithContext[],
  ): PreparedChunk[] {
    const texts = chunks.map((chunk) => formatChunkText(chunk, path));
    const prepared: PreparedChunk[] = [];

    for (let i = 0; i < texts.length; i++) {
      const chunk = chunks[i];
      const { content, displayText } = texts[i];
      const prev = texts[i - 1]?.displayText;
      const next = texts[i + 1]?.displayText;

      prepared.push({
        id: uuidv4(),
        path,
        hash,
        content: content, // Now minimal
        display_text: displayText, // Now rich
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
    onProgress?: () => void,
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
    const hybrids = await this.computeHybrid(
      preparedChunks.map((chunk) => chunk.content),
      onProgress,
    );

    const vectors = preparedChunks.map((chunk, idx) => {
      const hybrid = hybrids[idx] ?? {
        dense: new Float32Array(),
        colbert: new Int8Array(),
        scale: 1,
      };
      return {
        ...chunk,
        vector: hybrid.dense,
        colbert: Buffer.from(hybrid.colbert),
        colbert_scale: hybrid.scale,
        pooled_colbert_48d: hybrid.pooled_colbert_48d,
        doc_token_ids: hybrid.token_ids,
      };
    });

    onProgress?.();
    return { vectors, hash, mtimeMs, size };
  }

  async encodeQuery(text: string): Promise<{
    dense: number[];
    colbert: number[][];
    colbertDim: number;
    pooled_colbert_48d?: number[];
  }> {
    await this.ensureReady();

    const [denseVector] = await this.granite.runBatch([text]);

    const encoded = await this.colbert.encodeQuery(text);

    const feeds = {
      input_ids: new ort.Tensor("int64", encoded.input_ids, [
        1,
        encoded.input_ids.length,
      ]),
      attention_mask: new ort.Tensor("int64", encoded.attention_mask, [
        1,
        encoded.attention_mask.length,
      ]),
    };

    const sessionOut = await this.colbert.runSession(feeds);
    const outputName = this.colbert.getOutputName();
    const output = sessionOut[outputName];
    if (!output) {
      throw new Error("ColBERT session output missing embeddings tensor");
    }

    const data = output.data as Float32Array;
    const [, seq, dim] = output.dims as number[];

    const matrix: number[][] = [];

    for (let s = 0; s < seq; s++) {
      let sumSq = 0;
      const offset = s * dim;
      for (let d = 0; d < dim; d++) {
        const val = data[offset + d];
        sumSq += val * val;
      }
      const norm = Math.sqrt(sumSq);

      const row: number[] = [];
      if (norm > 1e-9) {
        for (let d = 0; d < dim; d++) {
          row.push(data[offset + d] / norm);
        }
      } else {
        for (let d = 0; d < dim; d++) {
          row.push(data[offset + d]);
        }
      }
      matrix.push(row);
    }

    // Compute pooled embedding (mean of tokens)
    const pooled = new Float32Array(dim);
    for (const row of matrix) {
      for (let d = 0; d < dim; d++) {
        pooled[d] += row[d];
      }
    }
    // Normalize pooled
    let sumSq = 0;
    for (let d = 0; d < dim; d++) {
      pooled[d] /= matrix.length || 1;
      sumSq += pooled[d] * pooled[d];
    }
    const norm = Math.sqrt(sumSq);
    if (norm > 1e-9) {
      for (let d = 0; d < dim; d++) {
        pooled[d] /= norm;
      }
    }

    return {
      dense: Array.from(denseVector ?? []),
      colbert: matrix,
      colbertDim: dim,
      pooled_colbert_48d: Array.from(pooled),
    };
  }

  async rerank(input: {
    query: number[][];
    docs: RerankDoc[];
    colbertDim: number;
  }): Promise<number[]> {
    await this.ensureReady();
    const queryMatrix = input.query.map((row) =>
      row instanceof Float32Array ? row : new Float32Array(row),
    );

    return input.docs.map((doc) => {
      const col = doc.colbert;
      let colbert: Int8Array;

      if (col instanceof Int8Array) {
        colbert = col;
      } else if (Buffer.isBuffer(col)) {
        colbert = new Int8Array(col.buffer, col.byteOffset, col.byteLength);
      } else if (
        col &&
        typeof col === "object" &&
        "type" in col &&
        (col as any).type === "Buffer" &&
        Array.isArray((col as any).data)
      ) {
        // IPC serialization fallback (still copies, but unavoidable without SharedArrayBuffer)
        colbert = new Int8Array((col as any).data);
      } else if (Array.isArray(col)) {
        colbert = new Int8Array(col);
      } else {
        colbert = new Int8Array(0);
      }

      const seqLen = Math.floor(colbert.length / input.colbertDim);
      const docMatrix: Float32Array[] = [];
      for (let i = 0; i < seqLen; i++) {
        const start = i * input.colbertDim;
        const row = new Float32Array(input.colbertDim);
        for (let d = 0; d < input.colbertDim; d++) {
          row[d] = (colbert[start + d] * doc.scale) / 127.0;
        }
        docMatrix.push(row);
      }
      const tokenIds =
        Array.isArray(doc.token_ids) && doc.token_ids.length === seqLen
          ? doc.token_ids
          : undefined;
      return maxSim(queryMatrix, docMatrix, tokenIds);
    });
  }
}
