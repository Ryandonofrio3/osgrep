import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { MODEL_IDS, PATHS } from "../../config";

const LOG_MODELS =
  process.env.OSGREP_DEBUG_MODELS === "1" ||
  process.env.OSGREP_DEBUG_MODELS === "true";

/**
 * Triggers the download of models by spawning a worker thread.
 * This prevents the main thread from loading onnxruntime, avoiding exit crashes.
 */
export async function downloadModels(): Promise<void> {
  return new Promise((resolve, reject) => {
    const tsWorkerPath = path.join(__dirname, "../workers/download-worker.ts");
    const jsWorkerPath = path.join(__dirname, "../workers/download-worker.js");
    const hasTsWorker = fs.existsSync(tsWorkerPath);
    const hasJsWorker = fs.existsSync(jsWorkerPath);
    const runningTs = path.extname(__filename) === ".ts";
    const isDev = (runningTs && hasTsWorker) || (hasTsWorker && !hasJsWorker);

    const workerPath = isDev ? tsWorkerPath : jsWorkerPath;
    const execArgv = isDev ? ["-r", "ts-node/register"] : [];

    const worker = new Worker(workerPath, { execArgv });

    worker.on("message", (msg) => {
      if (msg.type === "progress") {
        // Ignore progress messages for now, or log if debug enabled
        return;
      }

      if (msg.status === "success") {
        if (LOG_MODELS) console.log("Worker: Models ready.");
        resolve();
      } else if (msg.status === "error") {
        reject(new Error(msg.error || "Unknown worker error"));
      }
      // Ignore other messages
    });

    worker.on("error", (err) => {
      reject(err);
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Download worker exited with code ${code}`));
      }
    });
  });
}

/**
 * Simple check to see if the cache folder exists for our models.
 * This is a loose check for the UI/Doctor command.
 */
export function areModelsDownloaded(): boolean {
  // Check if the model directories exist in the cache
  const embedPath = path.join(PATHS.models, ...MODEL_IDS.embed.split("/"));
  const colbertPath = path.join(PATHS.models, ...MODEL_IDS.colbert.split("/"));

  return fs.existsSync(embedPath) && fs.existsSync(colbertPath);
}
