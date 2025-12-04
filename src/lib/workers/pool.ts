import * as fs from "node:fs";
import * as path from "node:path";
import Piscina from "piscina";
import { CONFIG, WORKER_TIMEOUT_MS } from "../../config";

function resolveWorkerModule(): { filename: string; execArgv: string[] } {
  const jsWorker = path.join(__dirname, "worker.js");
  const tsWorker = path.join(__dirname, "worker.ts");

  if (fs.existsSync(jsWorker)) {
    return { filename: jsWorker, execArgv: [] };
  }

  if (fs.existsSync(tsWorker)) {
    return { filename: tsWorker, execArgv: ["-r", "ts-node/register"] };
  }

  throw new Error("Worker file not found");
}

export class WorkerPool {
  private pool: Piscina;
  private destroyed = false;

  constructor() {
    const { filename, execArgv } = resolveWorkerModule();
    this.pool = new Piscina({
      filename,
      execArgv,
      maxThreads: CONFIG.WORKER_THREADS,
      idleTimeout: WORKER_TIMEOUT_MS,
    });
  }

  processFile(input: { path: string; content: string; hash?: string }) {
    return this.pool.run(input);
  }

  encodeQuery(text: string) {
    return this.pool.run({ text }, { name: "encodeQuery" });
  }

  rerank(input: {
    query: number[][];
    docs: Array<{ colbert: Buffer | Int8Array | number[]; scale: number }>;
    colbertDim: number;
  }) {
    return this.pool.run(input, { name: "rerank" });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.pool.destroy();
  }
}

export const workerPool = new WorkerPool();
