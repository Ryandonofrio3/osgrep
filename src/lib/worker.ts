import * as os from "node:os";
import * as path from "node:path";
import { parentPort } from "node:worker_threads";
import { env, type PipelineType, pipeline } from "@huggingface/transformers";
import { MODEL_IDS } from "../config";

// Configure cache directory
const HOMEDIR = os.homedir();
const CACHE_DIR = path.join(HOMEDIR, ".osgrep", "models");

env.cacheDir = CACHE_DIR;
env.allowLocalModels = true;
// We start with false to prefer local, but will toggle if needed
env.allowRemoteModels = false;

type EmbedOptions = {
  pooling: "cls";
  normalize: boolean;
  truncation: boolean;
  max_length: number;
};

type EmbedOutput = {
  data: Float32Array | number[];
  dims?: number[];
};

type RerankInput = { text: string; text_pair: string };

type RerankResult = { logits?: number[] | number; score?: number };

type EmbedPipeline = (
  inputs: string[],
  options: EmbedOptions,
) => Promise<EmbedOutput>;

type RerankPipeline = (
  inputs: RerankInput[],
  options?: Record<string, unknown>,
) => Promise<RerankResult[]>;

class EmbeddingWorker {
  private embedPipe: EmbedPipeline | null = null;
  private rerankPipe: RerankPipeline | null = null;
  private embedModelId = MODEL_IDS.embed;
  private rerankModelId = MODEL_IDS.rerank;
  private readonly TARGET_DIMENSIONS = 384;

  private async loadPipeline<T extends EmbedPipeline | RerankPipeline>(
    task: PipelineType,
    model: string,
    options: Record<string, unknown>,
  ): Promise<T> {
    try {
      return (await pipeline(task, model, options)) as unknown as T;
    } catch {
      console.log("Worker: Local model not found. Downloading...");
      env.allowRemoteModels = true;
      const loaded = (await pipeline(task, model, options)) as unknown as T;
      env.allowRemoteModels = false;
      return loaded;
    }
  }

  async initialize() {
    if (this.embedPipe && this.rerankPipe) return;

    console.log(`Worker: Loading models from ${CACHE_DIR}...`);

    if (!this.embedPipe) {
      this.embedPipe = await this.loadPipeline<EmbedPipeline>(
        "feature-extraction",
        this.embedModelId,
        {
          dtype: "q8",
          quantized: true,
        },
      );
    }

    if (!this.rerankPipe) {
      this.rerankPipe = await this.loadPipeline<RerankPipeline>(
        "text-classification",
        this.rerankModelId,
        {
          dtype: "q8",
          quantized: true,
        },
      );
    }

    console.log("Worker: Models loaded.");
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.embedPipe) await this.initialize();
    const embedPipe = this.embedPipe;
    if (!embedPipe) throw new Error("Embedding pipeline not initialized");

    const output = await embedPipe(texts, {
      pooling: "cls",
      normalize: true,
      truncation: true,
      max_length: 4096,
    });

    // Handle both single and batch outputs
    const embeddings: number[][] = [];
    const dims = output.dims || [1, output.data.length];
    const batchSize = dims.length >= 2 ? dims[0] : 1;
    const hiddenSize =
      dims.length >= 2 ? dims[dims.length - 1] : (output.data.length as number);

    for (let i = 0; i < batchSize; i++) {
      const start = i * hiddenSize;
      const slice = output.data.slice(
        start,
        start + Math.min(this.TARGET_DIMENSIONS, hiddenSize),
      );
      const vec: number[] = Array.from(slice as ArrayLike<number>);
      if (vec.length < this.TARGET_DIMENSIONS) {
        vec.push(...Array(this.TARGET_DIMENSIONS - vec.length).fill(0));
      }
      embeddings.push(vec);
    }

    return embeddings;
  }

  async rerank(query: string, documents: string[]): Promise<number[]> {
    if (!this.rerankPipe) await this.initialize();
    const rerankPipe = this.rerankPipe;
    if (!rerankPipe) throw new Error("Rerank pipeline not initialized");
    const inputs = documents.map((doc) => ({ text: query, text_pair: doc }));
    const results = await rerankPipe(inputs, { top_k: null });
    return results.map((result) => {
      const logits = Array.isArray(result.logits)
        ? result.logits[0]
        : result.logits;
      if (typeof logits === "number") {
        return 1 / (1 + Math.exp(-logits));
      }
      return typeof result.score === "number" ? result.score : 0;
    });
  }
}

const worker = new EmbeddingWorker();

if (parentPort) {
  parentPort.on(
    "message",
    async (message: {
      id: string;
      type?: string;
      text?: string;
      texts?: string[];
      rerank?: { query: string; documents: string[] };
    }) => {
      try {
        // Handle graceful shutdown
        if (message.type === "shutdown") {
          process.exit(0);
          return;
        }

        if (message.rerank) {
          const scores = await worker.rerank(
            message.rerank.query,
            message.rerank.documents,
          );
          parentPort?.postMessage({ id: message.id, scores });
          return;
        }

        const inputs = message.texts || (message.text ? [message.text] : []);
        if (inputs.length === 0) {
          throw new Error("No text provided");
        }

        const vectors = await worker.embed(inputs);
        const memory = process.memoryUsage();

        if (message.text && !message.texts) {
          parentPort?.postMessage({
            id: message.id,
            vector: vectors[0],
            memory,
          });
        } else {
          parentPort?.postMessage({ id: message.id, vectors, memory });
        }
      } catch (error) {
        console.error("Worker error:", error);
        parentPort?.postMessage({
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
