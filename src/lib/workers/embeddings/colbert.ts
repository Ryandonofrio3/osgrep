import * as fs from "node:fs";
import * as path from "node:path";
import * as ort from "onnxruntime-node";
import { MODEL_IDS, PATHS } from "../../../config";
import { ColBERTTokenizer } from "../colbert-tokenizer";

const CACHE_DIR = PATHS.models;
const ONNX_THREADS = 1;
const LOG_MODELS =
  process.env.OSGREP_DEBUG_MODELS === "1" ||
  process.env.OSGREP_DEBUG_MODELS === "true";
const log = (...args: unknown[]) => {
  if (LOG_MODELS) console.log(...args);
};

export type HybridResult = {
  dense: Float32Array;
  colbert: Int8Array;
  scale: number;
  pooled_colbert_48d?: Float32Array;
  token_ids?: number[];
};

export class ColbertModel {
  private session: ort.InferenceSession | null = null;
  public tokenizer: ColBERTTokenizer | null = null;

  async load() {
    if (this.session && this.tokenizer) return;

    this.tokenizer = new ColBERTTokenizer();

    const basePath = path.join(CACHE_DIR, MODEL_IDS.colbert);
    const onnxDir = path.join(basePath, "onnx");

    const modelPath = path.join(onnxDir, "model.onnx");
    if (!fs.existsSync(modelPath)) {
      throw new Error(`ColBERT ONNX model not found at ${modelPath}`);
    }

    await this.tokenizer.init(basePath);

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ["cpu"],
      intraOpNumThreads: ONNX_THREADS,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    };

    log(`Worker: Loading ColBERT ONNX session from ${modelPath}`);
    this.session = await ort.InferenceSession.create(modelPath, sessionOptions);

    if (!this.session) {
      throw new Error(`ColBERT ONNX load failed; tried ${modelPath}`);
    }
  }

  isReady(): boolean {
    return !!(this.session && this.tokenizer);
  }

  async runBatch(
    texts: string[],
    denseVectors: Float32Array[],
    vectorDimensions: number,
  ): Promise<HybridResult[]> {
    if (!this.session || !this.tokenizer) return [];
    const tokenizer = this.tokenizer;
    const session = this.session;

    const encodedBatch = await Promise.all(
      texts.map((t) => tokenizer.encodeDoc(t)),
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
      input_ids: new ort.Tensor("int64", batchInputIds, [texts.length, maxLen]),
      attention_mask: new ort.Tensor("int64", batchAttentionMask, [
        texts.length,
        maxLen,
      ]),
    };

    const sessionOut = await session.run(feeds);
    const outputName = session.outputNames[0];
    const output = sessionOut[outputName];
    if (!output) {
      throw new Error("ColBERT session output missing embeddings tensor");
    }

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
        dense: denseVectors[b] ?? new Float32Array(vectorDimensions).fill(0),
        colbert: int8Array,
        scale: maxVal,
        pooled_colbert_48d: pooled,
        token_ids: Array.from(encodedBatch[b].input_ids, (v) => Number(v)),
      });
    }

    return results;
  }

  async encodeQuery(text: string): Promise<{
    input_ids: BigInt64Array;
    attention_mask: BigInt64Array;
  }> {
    if (!this.tokenizer) throw new Error("ColBERT tokenizer not initialized");
    const encoded = await this.tokenizer.encodeQuery(text);
    return {
      input_ids: new BigInt64Array(encoded.input_ids),
      attention_mask: new BigInt64Array(encoded.attention_mask),
    };
  }

  async runSession(
    feeds: Record<string, ort.Tensor>,
  ): Promise<ort.InferenceSession.OnnxValueMapType> {
    if (!this.session) throw new Error("ColBERT session not initialized");
    return this.session.run(feeds);
  }

  getOutputName(): string {
    if (!this.session) throw new Error("ColBERT session not initialized");
    return this.session.outputNames[0];
  }
}
