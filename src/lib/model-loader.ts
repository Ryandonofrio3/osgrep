import * as os from "node:os";
import * as path from "node:path";
import { env, pipeline } from "@huggingface/transformers";
import { MODEL_IDS } from "../config";

const HOMEDIR = os.homedir();
const CACHE_DIR = path.join(HOMEDIR, ".osgrep", "models");

type DisposablePipeline = {
  dispose?: () => Promise<unknown> | void;
};

/**
 * Downloads ML models to local cache directory
 * This is a standalone function that can be called during setup
 */
export async function downloadModels(): Promise<void> {
  // Configure cache directory
  env.cacheDir = CACHE_DIR;
  env.allowLocalModels = true;
  env.allowRemoteModels = true; // Enable remote for downloading

  const embedModelId = MODEL_IDS.embed;
  const rerankModelId = MODEL_IDS.rerank;

  console.log(`Worker: Loading models from ${CACHE_DIR}...`);

  const loadedPipelines: DisposablePipeline[] = [];

  try {
    const embedOptions: Record<string, unknown> = {
      dtype: "q8",
      quantized: true,
    };
    // Load embed model
    const embedPipeline = (await pipeline(
      "feature-extraction",
      embedModelId,
      embedOptions,
    )) as unknown as DisposablePipeline;
    loadedPipelines.push(embedPipeline);

    const rerankOptions: Record<string, unknown> = {
      dtype: "q8",
      quantized: true,
    };
    // Load rerank model
    const rerankPipeline = (await pipeline(
      "text-classification",
      rerankModelId,
      rerankOptions,
    )) as unknown as DisposablePipeline;
    loadedPipelines.push(rerankPipeline);

    console.log("Worker: Models loaded.");
  } finally {
    // Dispose pipelines to clean up native resources before exit
    const disposers: Array<Promise<unknown> | void> = [];
    for (const pipe of loadedPipelines) {
      if (typeof pipe.dispose === "function") {
        disposers.push(pipe.dispose());
      }
    }
    await Promise.allSettled(disposers);
    // Reset to prefer local after download
    env.allowRemoteModels = false;
  }
}

/**
 * Check if models are already downloaded
 */
export function areModelsDownloaded(): boolean {
  const fs = require("node:fs");
  const embedModelPath = path.join(CACHE_DIR, ...MODEL_IDS.embed.split("/"));
  const rerankModelPath = path.join(CACHE_DIR, ...MODEL_IDS.rerank.split("/"));

  return fs.existsSync(embedModelPath) && fs.existsSync(rerankModelPath);
}
