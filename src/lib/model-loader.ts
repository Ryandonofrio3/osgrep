import * as os from "node:os";
import * as path from "node:path";
import { env, pipeline } from "@huggingface/transformers";

const HOMEDIR = os.homedir();
const CACHE_DIR = path.join(HOMEDIR, ".osgrep", "models");

/**
 * Downloads ML models to local cache directory
 * This is a standalone function that can be called during setup
 */
export async function downloadModels(): Promise<void> {
  // Configure cache directory
  env.cacheDir = CACHE_DIR;
  env.allowLocalModels = true;
  env.allowRemoteModels = true; // Enable remote for downloading

  const embedModelId = "mixedbread-ai/mxbai-embed-xsmall-v1";
  const rerankModelId = "mixedbread-ai/mxbai-rerank-xsmall-v1";

  console.log(`Worker: Loading models from ${CACHE_DIR}...`);

  const loadedPipelines = [];

  try {
    // Load embed model
    const embedPipeline = await pipeline("feature-extraction", embedModelId, {
      dtype: "q8",
      quantized: true,
    } as any);
    loadedPipelines.push(embedPipeline);

    // Load rerank model
    const rerankPipeline = await pipeline(
      "text-classification",
      rerankModelId,
      {
        dtype: "q8",
        quantized: true,
      } as any,
    );
    loadedPipelines.push(rerankPipeline);

    console.log("Worker: Models loaded.");
  } finally {
    // Dispose pipelines to clean up native resources before exit
    await Promise.allSettled(
      loadedPipelines
        .filter((pipe: any) => typeof pipe?.dispose === "function")
        .map((pipe: any) => pipe.dispose()),
    );
    // Reset to prefer local after download
    env.allowRemoteModels = false;
  }
}

/**
 * Check if models are already downloaded
 */
export function areModelsDownloaded(): boolean {
  const fs = require("node:fs");
  const embedModelPath = path.join(
    CACHE_DIR,
    "mixedbread-ai",
    "mxbai-embed-xsmall-v1",
  );
  const rerankModelPath = path.join(
    CACHE_DIR,
    "mixedbread-ai",
    "mxbai-rerank-xsmall-v1",
  );

  return fs.existsSync(embedModelPath) && fs.existsSync(rerankModelPath);
}
