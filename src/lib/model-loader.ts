import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { env, pipeline } from "@huggingface/transformers";
import { MODEL_IDS } from "../config";

const HOMEDIR = os.homedir();
const CACHE_DIR = path.join(HOMEDIR, ".osgrep", "models");
const LOG_MODELS =
  process.env.OSGREP_DEBUG_MODELS === "1" ||
  process.env.OSGREP_DEBUG_MODELS === "true";

// Ensure transformers knows where to look/save
env.cacheDir = CACHE_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = true;

/**
 * Triggers the download of models by simply initializing the pipelines.
 * transformers.js handles the caching logic automatically.
 */
export async function downloadModels(): Promise<void> {

  try {
    // 1. Download Dense Model
    await pipeline("feature-extraction", MODEL_IDS.embed, {
      dtype: "int8", 
    });

    // 2. Download ColBERT Model
    await pipeline("feature-extraction", MODEL_IDS.colbert, {
      dtype: "q8", 
    });

    if (LOG_MODELS) {
      console.log("Worker: Models ready.");
    }
  } catch (err) {
    console.error("Failed to download models:", err);
    throw err;
  }
}

/**
 * Simple check to see if the cache folder exists for our models.
 * This is a loose check for the UI/Doctor command.
 */
export function areModelsDownloaded(): boolean {
  // Check if the model directories exist in the cache
  const embedPath = path.join(CACHE_DIR, ...MODEL_IDS.embed.split("/"));
  const colbertPath = path.join(CACHE_DIR, ...MODEL_IDS.colbert.split("/"));
  
  return fs.existsSync(embedPath) && fs.existsSync(colbertPath);
}
