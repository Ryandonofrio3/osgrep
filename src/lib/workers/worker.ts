import * as fs from "node:fs";
import * as path from "node:path";
import * as ort from "onnxruntime-node";
import { AutoTokenizer, env, type PreTrainedTokenizer } from "@huggingface/transformers";
import { v4 as uuidv4 } from "uuid";
import { CONFIG, MODEL_IDS, PATHS } from "../../config";
import {
  TreeSitterChunker,
  buildAnchorChunk,
  formatChunkText,
  type ChunkWithContext,
} from "../index/chunker";
import { ColBERTTokenizer } from "./colbert-tokenizer";
import { maxSim } from "./colbert-math";
import type { PreparedChunk, VectorRecord } from "../store/types";

type HybridResult = {
  dense: Float32Array;
  colbert: Int8Array;
  scale: number;
  pooled_colbert_48d?: Float32Array;
};

type ProcessFileInput = {
  path: string;
  content: string;
  hash?: string;
};

type RerankDoc = {
  colbert: Buffer | Int8Array | number[];
  scale: number;
};

const CACHE_DIR = PATHS.models;
const ONNX_THREADS = 1;
const LOG_MODELS =
  process.env.OSGREP_DEBUG_MODELS === "1" ||
  process.env.OSGREP_DEBUG_MODELS === "true";
const log = (...args: unknown[]) => {
  if (LOG_MODELS) console.log(...args);
};

env.cacheDir = CACHE_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = true;

const PROJECT_ROOT = process.cwd();
const LOCAL_MODELS = path.join(PROJECT_ROOT, "models");
if (fs.existsSync(LOCAL_MODELS)) {
  env.localModelPath = LOCAL_MODELS;
  log(`Worker: Using local models from ${LOCAL_MODELS}`);
}

class WorkerRuntime {
  private embedSession: ort.InferenceSession | null = null;
  private embedTokenizer: PreTrainedTokenizer | null = null;

  private colbertSession: ort.InferenceSession | null = null;
  private colbertTokenizer: ColBERTTokenizer | null = null;

  private readonly vectorDimensions = CONFIG.VECTOR_DIM;
  private initPromise: Promise<void> | null = null;
  private chunker = new TreeSitterChunker();

  private resolveGranitePaths(): { modelPath: string; tokenizerPath: string } {
    const basePath = path.join(CACHE_DIR, MODEL_IDS.embed);
    const onnxDir = path.join(basePath, "onnx");
    const candidates = ["model_q4.onnx", "model.onnx"];

    for (const candidate of candidates) {
      const candidatePath = path.join(onnxDir, candidate);
      if (fs.existsSync(candidatePath)) {
        return { modelPath: candidatePath, tokenizerPath: basePath };
      }
    }

    throw new Error(
      `Granite ONNX model not found. Looked for ${candidates.join(
        ", ",
      )} in ${onnxDir}`,
    );
  }

  private async loadGranite() {
    if (this.embedSession && this.embedTokenizer) return;

    const { modelPath, tokenizerPath } = this.resolveGranitePaths();
    log(`Worker: Loading Granite ONNX session from ${modelPath}`);

    this.embedTokenizer = await AutoTokenizer.from_pretrained(tokenizerPath);

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ["cpu"],
      intraOpNumThreads: ONNX_THREADS,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    };
    this.embedSession = await ort.InferenceSession.create(modelPath, sessionOptions);
  }

  private async loadColbert() {
    if (this.colbertSession && this.colbertTokenizer) return;

    this.colbertTokenizer = new ColBERTTokenizer();

    const basePath = path.join(CACHE_DIR, MODEL_IDS.colbert);
    const onnxDir = path.join(basePath, "onnx");
    const candidates = ["model.onnx", "model_quantized.onnx", "model_q4.onnx"];
    const resolved = candidates
      .map((name) => path.join(onnxDir, name))
      .find((candidate) => fs.existsSync(candidate));

    if (!resolved) {
      throw new Error(
        `ColBERT ONNX model not found. Expected one of ${candidates.join(
          ", ",
        )} in ${onnxDir}`,
      );
    }

    await this.colbertTokenizer.init(basePath);

    log(`Worker: Loading ColBERT ONNX session from ${resolved}`);

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ["cpu"],
      intraOpNumThreads: ONNX_THREADS,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    };

    this.colbertSession = await ort.InferenceSession.create(resolved, sessionOptions);
  }

  private async ensureReady() {
    if (
      this.embedSession &&
      this.embedTokenizer &&
      this.colbertSession &&
      this.colbertTokenizer
    ) {
      return;
    }
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await Promise.all([this.chunker.init(), this.loadGranite(), this.loadColbert()]);
    })().finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  private meanPool(
    hidden: Float32Array,
    attention: BigInt64Array,
    batch: number,
    seq: number,
    hiddenDim: number,
    targetDim: number,
  ): Float32Array[] {
    const vectors: Float32Array[] = [];
    const seqFromMask = attention.length / Math.max(1, batch);
    const usableSeq = Math.min(seq, seqFromMask);
    const dim = Math.min(hiddenDim, targetDim);

    for (let b = 0; b < batch; b++) {
      const sum = new Float32Array(dim);
      let count = 0;
      const attOffset = b * seqFromMask;
      const hiddenOffset = b * seq * hiddenDim;

      for (let s = 0; s < usableSeq; s++) {
        if (attention[attOffset + s] > 0) {
          count++;
          const tokenOffset = hiddenOffset + s * hiddenDim;
          for (let d = 0; d < dim; d++) {
            sum[d] += hidden[tokenOffset + d];
          }
        }
      }

      if (count === 0) count = 1;
      let norm = 0;
      for (let d = 0; d < dim; d++) {
        sum[d] /= count;
        norm += sum[d] * sum[d];
      }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dim; d++) {
        sum[d] /= norm;
      }

      if (dim < targetDim) {
        const padded = new Float32Array(targetDim);
        padded.set(sum);
        vectors.push(padded);
      } else {
        vectors.push(sum);
      }
    }

    return vectors;
  }

  private async runGraniteBatch(texts: string[]): Promise<Float32Array[]> {
    await this.ensureReady();
    if (!this.embedSession || !this.embedTokenizer) return [];

    const encoded = await this.embedTokenizer(texts, {
      padding: true,
      truncation: true,
      max_length: 256,
    });

    const inputIds = encoded.input_ids.data as BigInt64Array;
    const attentionMask = encoded.attention_mask.data as BigInt64Array;
    const seqLen =
      encoded.input_ids.dims?.[1] ??
      Math.max(1, Math.floor(inputIds.length / texts.length));

    const tokenTypeIdsRaw =
      (encoded as any).token_type_ids?.data as BigInt64Array | undefined;
    const tokenTypeIds =
      tokenTypeIdsRaw && tokenTypeIdsRaw.length === inputIds.length
        ? tokenTypeIdsRaw
        : new BigInt64Array(inputIds.length).fill(BigInt(0));

    const feeds = {
      input_ids: new ort.Tensor("int64", inputIds, [texts.length, seqLen]),
      attention_mask: new ort.Tensor(
        "int64",
        attentionMask,
        [texts.length, seqLen],
      ),
      token_type_ids: new ort.Tensor(
        "int64",
        tokenTypeIds,
        [texts.length, seqLen],
      ),
    };

    const sessionOut = await this.embedSession.run(feeds);
    const hidden =
      sessionOut["last_hidden_state"] ??
      sessionOut[this.embedSession.outputNames[0]];

    if (!hidden) {
      throw new Error("Granite ONNX output missing last_hidden_state");
    }

    const hiddenData = hidden.data as Float32Array;
    const [batch, seq, dim] = hidden.dims as number[];
    return this.meanPool(
      hiddenData,
      attentionMask,
      batch,
      seq,
      dim,
      this.vectorDimensions,
    );
  }

  private async runColbertBatch(
    texts: string[],
    denseVectors: Float32Array[],
  ): Promise<HybridResult[]> {
    await this.ensureReady();
    if (!this.colbertSession || !this.colbertTokenizer) return [];

    const encodedBatch = await Promise.all(
      texts.map((t) => this.colbertTokenizer!.encodeDoc(t)),
    );

    const maxLen = Math.max(...encodedBatch.map((e) => e.input_ids.length));
    const batchInputIds = new BigInt64Array(texts.length * maxLen);
    const batchAttentionMask = new BigInt64Array(texts.length * maxLen);
    const padId = BigInt(50283);

    for (let i = 0; i < encodedBatch.length; i++) {
      const encoded = encodedBatch[i];
      const offset = i * maxLen;
      for (let j = 0; j < maxLen; j++) {
        if (j < encoded.input_ids.length) {
          batchInputIds[offset + j] = encoded.input_ids[j];
          batchAttentionMask[offset + j] = encoded.attention_mask[j];
        } else {
          batchInputIds[offset + j] = padId;
          batchAttentionMask[offset + j] = BigInt(0);
        }
      }
    }

    const feeds = {
      input_ids: new ort.Tensor("int64", batchInputIds, [
        texts.length,
        maxLen,
      ]),
      attention_mask: new ort.Tensor("int64", batchAttentionMask, [
        texts.length,
        maxLen,
      ]),
    };

    const sessionOut = await this.colbertSession.run(feeds);
    const output = sessionOut[this.colbertSession.outputNames[0]];

    const data = output.data as Float32Array;
    const [batch, seq, dim] = output.dims as number[];
    const results: HybridResult[] = [];

    for (let b = 0; b < batch; b++) {
      const batchOffset = b * seq * dim;
      const originalLen = encodedBatch[b].input_ids.length;
      const normalized = new Float32Array(originalLen * dim);
      let maxVal = 0;

      for (let s = 0; s < originalLen; s++) {
        const offset = batchOffset + s * dim;
        let sumSq = 0;
        for (let d = 0; d < dim; d++) {
          const val = data[offset + d];
          sumSq += val * val;
        }
        const norm = Math.sqrt(sumSq) || 1;

        for (let d = 0; d < dim; d++) {
          const val = data[offset + d] / norm;
          const idx = s * dim + d;
          normalized[idx] = val;
          if (Math.abs(val) > maxVal) maxVal = Math.abs(val);
        }
      }

      if (maxVal === 0) maxVal = 1;

      const int8Array = new Int8Array(normalized.length);
      for (let i = 0; i < normalized.length; i++) {
        int8Array[i] = Math.max(
          -127,
          Math.min(127, Math.round((normalized[i] / maxVal) * 127)),
        );
      }

      const pooled = new Float32Array(dim);
      const tokenCount = Math.max(1, originalLen);
      for (let s = 0; s < originalLen; s++) {
        const tokenOffset = s * dim;
        for (let d = 0; d < dim; d++) {
          pooled[d] += normalized[tokenOffset + d];
        }
      }
      let pooledNorm = 0;
      for (let d = 0; d < dim; d++) {
        pooled[d] /= tokenCount;
        pooledNorm += pooled[d] * pooled[d];
      }
      pooledNorm = Math.sqrt(pooledNorm) || 1;
      for (let d = 0; d < dim; d++) {
        pooled[d] /= pooledNorm;
      }

      results.push({
        dense:
          denseVectors[b] ??
          new Float32Array(this.vectorDimensions).fill(0),
        colbert: int8Array,
        scale: maxVal,
        pooled_colbert_48d: pooled,
      });
    }

    return results;
  }

  async computeHybrid(texts: string[]): Promise<HybridResult[]> {
    if (!texts.length) return [];
    await this.ensureReady();

    const results: HybridResult[] = [];
    const envBatch = Number.parseInt(process.env.OSGREP_WORKER_BATCH_SIZE ?? "", 10);
    const BATCH_SIZE =
      Number.isFinite(envBatch) && envBatch > 0
        ? Math.max(4, Math.min(16, envBatch))
        : 16;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batchTexts = texts.slice(i, i + BATCH_SIZE);
      const denseBatch = await this.runGraniteBatch(batchTexts);
      const colbertBatch = await this.runColbertBatch(batchTexts, denseBatch);
      results.push(...colbertBatch);
    }

    return results;
  }

  private async chunkFile(pathname: string, content: string): Promise<ChunkWithContext[]> {
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
      const prev = texts[i - 1];
      const next = texts[i + 1];

      prepared.push({
        id: uuidv4(),
        path,
        hash,
        content: texts[i],
        context_prev: typeof prev === "string" ? prev : undefined,
        context_next: typeof next === "string" ? next : undefined,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        chunk_index: chunk.chunkIndex,
        is_anchor: chunk.isAnchor === true,
        chunk_type: typeof chunk.type === "string" ? chunk.type : undefined,
      });
    }

    return prepared;
  }

  async processFile(input: ProcessFileInput): Promise<VectorRecord[]> {
    await this.ensureReady();
    const hash = input.hash ?? "";
    const chunks = await this.chunkFile(input.path, input.content);
    if (!chunks.length) return [];

    const preparedChunks = this.toPreparedChunks(input.path, hash, chunks);
    const hybrids = await this.computeHybrid(
      preparedChunks.map((chunk) => chunk.content),
    );

    return preparedChunks.map((chunk, idx) => {
      const hybrid = hybrids[idx] ?? {
        dense: new Float32Array(),
        colbert: new Int8Array(),
        scale: 1,
      };
      return {
        ...chunk,
        vector: hybrid.dense,
        colbert: hybrid.colbert,
        colbert_scale: hybrid.scale,
        pooled_colbert_48d: hybrid.pooled_colbert_48d,
      };
    });
  }

  async encodeQuery(
    text: string,
  ): Promise<{ dense: number[]; colbert: number[][]; colbertDim: number }> {
    await this.ensureReady();

    const [denseVector] = await this.runGraniteBatch([text]);
    const encoded = await this.colbertTokenizer!.encodeQuery(text);

    const feeds = {
      input_ids: new ort.Tensor(
        "int64",
        encoded.input_ids,
        [1, encoded.input_ids.length],
      ),
      attention_mask: new ort.Tensor(
        "int64",
        encoded.attention_mask,
        [1, encoded.attention_mask.length],
      ),
    };

    const sessionOut = await this.colbertSession!.run(feeds);
    const output = sessionOut[this.colbertSession!.outputNames[0]];

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

    return {
      dense: Array.from(denseVector ?? []),
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
    const queryMatrix = input.query.map((row) =>
      row instanceof Float32Array ? row : new Float32Array(row),
    );

    return input.docs.map((doc) => {
      const col = doc.colbert;
      const colbert =
        col instanceof Int8Array
          ? col
          : Buffer.isBuffer(col)
            ? new Int8Array(col.buffer, col.byteOffset, col.byteLength)
            : new Int8Array(col);

      if (!colbert.length) return 0;
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
      return maxSim(queryMatrix, docMatrix);
    });
  }
}

const runtime = new WorkerRuntime();

export default async function processFile(input: ProcessFileInput): Promise<VectorRecord[]> {
  return runtime.processFile(input);
}

export async function encodeQuery(input: { text: string }) {
  return runtime.encodeQuery(input.text);
}

export async function rerank(input: {
  query: number[][];
  docs: RerankDoc[];
  colbertDim: number;
}) {
  return runtime.rerank(input);
}
