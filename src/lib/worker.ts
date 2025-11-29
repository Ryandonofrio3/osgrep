import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parentPort } from "node:worker_threads";
import { env, type PipelineType, pipeline } from "@huggingface/transformers";
import { CONFIG, MODEL_IDS } from "../config";

function resolveThreadCount(): number {
  const fromEnv = Number.parseInt(process.env.OSGREP_THREADS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (process.env.OSGREP_LOW_IMPACT === "1") return 1;
  const cores = os.cpus().length || 1;
  // Default: leave one core for UI, and cap at 4 to avoid pegging laptops
  return Math.max(1, Math.min(cores - 1, 4));
}

// Configure cache directory
const HOMEDIR = os.homedir();
const CACHE_DIR = path.join(HOMEDIR, ".osgrep", "models");
const NUM_THREADS = resolveThreadCount();
const LOG_MODELS =
  process.env.OSGREP_DEBUG_MODELS === "1" ||
  process.env.OSGREP_DEBUG_MODELS === "true";
const log = (...args: unknown[]) => {
  if (LOG_MODELS) console.log(...args);
};

// Configure ONNX Runtime threading before loading pipelines.
const onnxBackend = env.backends.onnx as any;
onnxBackend.intraOpNumThreads = NUM_THREADS;
onnxBackend.interOpNumThreads = Math.max(1, Math.min(NUM_THREADS, 2));
if (onnxBackend.wasm) {
  onnxBackend.wasm.numThreads = NUM_THREADS;
}

// Try to find local models directory (for development/testing)
const PROJECT_ROOT = process.cwd();
const LOCAL_MODELS = path.join(PROJECT_ROOT, "models");
if (fs.existsSync(LOCAL_MODELS)) {
  env.localModelPath = LOCAL_MODELS;
  log(`Worker: Using local models from ${LOCAL_MODELS}`);
}

env.cacheDir = CACHE_DIR;
env.allowLocalModels = true;
// We start with false to prefer local, but will toggle if needed
env.allowRemoteModels = false;

type EmbedOptions = {
  pooling: "cls" | "none" | "mean";
  normalize: boolean;
  truncation?: boolean;
  max_length?: number;
  padding?: boolean;
};

type EmbedOutput = {
  data: Float32Array | number[];
  dims?: number[];
};

type EmbedPipeline = (
  inputs: string[],
  options: EmbedOptions,
) => Promise<EmbedOutput>;

class EmbeddingWorker {
  private embedPipe: EmbedPipeline | null = null;
  private colbertPipe: EmbedPipeline | null = null;
  private embedModelId = MODEL_IDS.embed;
  private colbertModelId = MODEL_IDS.colbert;
  private readonly vectorDimensions = CONFIG.VECTOR_DIMENSIONS;
  private readonly colbertDimensions = CONFIG.COLBERT_DIM;
  private initPromise: Promise<void> | null = null;

  private async loadPipeline<T extends EmbedPipeline>(
    task: PipelineType,
    model: string,
    options: Record<string, unknown>,
  ): Promise<T> {
    const tryLoad = async (device?: string) => {
      const opts = { ...options, device } as any;
      try {
        return (await pipeline(task, model, opts)) as unknown as T;
      } catch {
        log("Worker: Local model not found or failed. Downloading/Retrying...");
        env.allowRemoteModels = true;
        try {
          return (await pipeline(task, model, opts)) as unknown as T;
        } finally {
          env.allowRemoteModels = false;
        }
      }
    };

    const preferredDevice = process.env.OSGREP_DEVICE;

    try {
      return await tryLoad(preferredDevice);
    } catch (error) {
      if (preferredDevice !== "cpu") {
        console.warn(
          `Worker: Failed to load model with device "${preferredDevice ?? "auto"}". Falling back to CPU.`,
        );
        try {
          return await tryLoad("cpu");
        } catch (cpuError) {
          throw new Error(`Failed to load pipeline for ${model}: ${cpuError instanceof Error ? cpuError.message : String(cpuError)}`);
        }
      }
      throw new Error(`Failed to load pipeline for ${model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async initialize() {
    if (this.embedPipe && this.colbertPipe) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        log(`Worker: Loading models from ${CACHE_DIR}...`);

        if (!this.embedPipe) {
          this.embedPipe = await this.loadPipeline<EmbedPipeline>(
            "feature-extraction",
            this.embedModelId,
            {
              dtype: "q4",
            },
          );
        }

        if (!this.colbertPipe) {
          // ColBERT model for late-interaction reranking (custom q8 build)
          this.colbertPipe = await this.loadPipeline<EmbedPipeline>(
            "feature-extraction",
            this.colbertModelId,
            {
              dtype: "q8",
              quantized: true,
            },
          );
        }

        log("Worker: Models loaded.");
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  private toDenseVectors(output: EmbedOutput): number[][] {
    const dims = output.dims || [1, this.vectorDimensions];

    // Handle 3D output [batch, seq, dim] - usually from 'feature-extraction' with 'cls' pooling
    // but sometimes ONNX returns [batch, 1, dim] or similar.
    let batchSize = 1;
    let hiddenSize = this.vectorDimensions;

    if (dims.length === 3) {
      batchSize = dims[0];
      // dims[1] is sequence length (should be 1 for pooled output)
      hiddenSize = dims[2];
    } else if (dims.length === 2) {
      batchSize = dims[0];
      hiddenSize = dims[1];
    } else if (dims.length === 1) {
      // Single vector
      hiddenSize = dims[0];
    }

    const embeddings: number[][] = [];
    for (let i = 0; i < batchSize; i++) {
      const start = i * hiddenSize;
      const slice = output.data.slice(
        start,
        start + Math.min(this.vectorDimensions, hiddenSize),
      );
      const vec: number[] = Array.from(slice as ArrayLike<number>);
      if (vec.length < this.vectorDimensions) {
        vec.push(...Array(this.vectorDimensions - vec.length).fill(0));
      }
      embeddings.push(vec);
    }

    return embeddings;
  }

  private checkMemoryPressure(): void {
    const usage = process.memoryUsage();
    const heapUsedMB = usage.heapUsed / 1024 / 1024;
    const rssUsedMB = usage.rss / 1024 / 1024;
    
    if (rssUsedMB > 1000) {
      console.warn(`Warning: High memory usage detected (RSS: ${rssUsedMB.toFixed(1)}MB)`);
      console.warn("This usually indicates large files. Consider using .osgrep-ignore to exclude files >1MB");
    } else if (heapUsedMB > 500) {
      console.warn(`Warning: High heap usage detected (Heap: ${heapUsedMB.toFixed(1)}MB)`);
      console.warn("Consider setting OSGREP_LOW_IMPACT=1 to reduce concurrent processing");
    }
  }

  async computeHybrid(
    texts: string[],
  ): Promise<Array<{ dense: number[]; colbert: Buffer; scale: number }>> {
    if (!this.embedPipe) await this.initialize();
    if (!this.colbertPipe) await this.initialize();
    
    this.checkMemoryPressure();

    // SEQUENTIAL EXECUTION (Reduces peak RAM usage)
    const denseOut = await this.embedPipe!(texts, {
      pooling: "cls",
      normalize: true,
      truncation: true,
      max_length: 256,
    });

    const colbertOut = await this.colbertPipe!(texts, {
      pooling: "none",
      normalize: true,
      padding: true,
      truncation: true,
      max_length: 512,
    });

    const denseVectors = this.toDenseVectors(denseOut);
    const results: Array<{ dense: number[]; colbert: Buffer; scale: number }> = [];

    if (!colbertOut.dims || colbertOut.dims.length < 3) {
      throw new Error("Invalid ColBERT output dimensions");
    }

    const [batchSize, seqLen, dim] = colbertOut.dims;
    for (let i = 0; i < batchSize; i++) {
      const denseVec = denseVectors[i] ?? [];

      const cStart = i * seqLen * dim;
      const cEnd = cStart + seqLen * dim;
      const cData = colbertOut.data.slice(cStart, cEnd);

      // Calculate scale (max absolute value)
      let maxVal = 0;
      for (let k = 0; k < cData.length; k++) {
        const abs = Math.abs(cData[k]);
        if (abs > maxVal) maxVal = abs;
      }
      if (maxVal === 0) maxVal = 1;

      const int8Array = new Int8Array(cData.length);
      for (let k = 0; k < cData.length; k++) {
        int8Array[k] = Math.max(
          -127,
          Math.min(127, Math.round((cData[k] / maxVal) * 127)),
        );
      }

      results.push({
        dense: denseVec,
        colbert: Buffer.from(int8Array),
        scale: maxVal,
      });
    }

    return results;
  }

  async encodeQuery(
    text: string,
  ): Promise<{ dense: number[]; colbert: number[][]; colbertDim: number }> {
    if (!this.embedPipe || !this.colbertPipe) await this.initialize();
    const embedPipe = this.embedPipe!;
    const colbertPipe = this.colbertPipe!;
    
    this.checkMemoryPressure();

    const denseOut = await embedPipe([text], {
      pooling: "cls",
      normalize: true,
      truncation: true,
      max_length: 256,
    });
    const denseVector = this.toDenseVectors(denseOut)[0] ?? [];

    const output = await colbertPipe([text], {
      pooling: "none",
      normalize: true,
      padding: true,
      truncation: true,
      max_length: 512,
    });

    if (!output.dims || output.dims.length < 3) {
      throw new Error("Invalid query output dimensions");
    }

    const [, seqLen, dim] = output.dims;
    const effectiveDim =
      typeof dim === "number" && Number.isFinite(dim)
        ? (dim as number)
        : this.colbertDimensions;
    const matrix: number[][] = [];
    for (let i = 0; i < seqLen; i++) {
      const start = i * effectiveDim;
      const row = Array.from(output.data.slice(start, start + effectiveDim));
      if (row.some((v) => v !== 0)) {
        matrix.push(row);
      }
    }

    return { dense: denseVector, colbert: matrix, colbertDim: effectiveDim };
  }

  async dispose(): Promise<void> {
    try {
      if (this.embedPipe && typeof (this.embedPipe as any).dispose === 'function') {
        await (this.embedPipe as any).dispose();
      }
      if (this.colbertPipe && typeof (this.colbertPipe as any).dispose === 'function') {
        await (this.colbertPipe as any).dispose();
      }
    } catch (error) {
      log("Worker: Error during pipeline disposal:", error);
    } finally {
      this.embedPipe = null;
      this.colbertPipe = null;
      this.initPromise = null;
    }
  }

}

const worker = new EmbeddingWorker();

// Cleanup on process exit
process.on('SIGINT', async () => {
  await worker.dispose();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await worker.dispose();
  process.exit(0);
});

process.on('beforeExit', async () => {
  await worker.dispose();
});

if (parentPort) {
  parentPort.on(
    "message",
    async (message: {
      id: string;
      type?: string;
      hybrid?: { texts: string[] };
      query?: { text: string };
    }) => {
      try {
        // Handle graceful shutdown
        if (message.type === "shutdown") {
          await worker.dispose();
          process.exit(0);
          return;
        }

        if (message.hybrid) {
          const hybrids = await worker.computeHybrid(message.hybrid.texts);
          const memory = process.memoryUsage();
          parentPort?.postMessage({ id: message.id, hybrids, memory });
          return;
        }

        if (message.query) {
          const query = await worker.encodeQuery(message.query.text);
          const memory = process.memoryUsage();
          parentPort?.postMessage({ id: message.id, query, memory });
          return;
        }

        throw new Error("Unknown message type");
      } catch (error) {
        console.error("Worker error:", error);
        
        // Check for memory-related errors and provide helpful guidance
        const errorMessage = error instanceof Error ? error.message : String(error);
        let userFriendlyMessage = errorMessage;
        
        if (errorMessage.includes('Napi::Error') || 
            errorMessage.includes('out of memory') || 
            errorMessage.includes('memory') ||
            errorMessage.includes('ENOMEM')) {
          userFriendlyMessage = `Memory exceeded while processing files. This usually happens when indexing very large files.\n\nTry:\n- Using .osgrep-ignore to exclude large files (>1MB)\n- Breaking up large files into smaller chunks\n- Check your repository for unusually large files\n\nOriginal error: ${errorMessage}`;
        }
        
        // Attempt cleanup on error to prevent memory leaks
        try {
          await worker.dispose();
        } catch (disposeError) {
          console.error("Worker: Failed to dispose on error:", disposeError);
        }
        parentPort?.postMessage({
          id: message.id,
          error: userFriendlyMessage,
        });
      }
    },
  );
}
