import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { v4 as uuidv4 } from "uuid";
import { MAX_WORKER_MEMORY_MB, WORKER_TIMEOUT_MS } from "../config";

type WorkerRequest =
  | { id: string; hybrid: { texts: string[] } }
  | { id: string; query: { text: string } }
  | { type: "shutdown" };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId?: NodeJS.Timeout;
};

export class WorkerManager {
  private worker: Worker | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private isClosing = false;

  // Mutex queue: ensures only 1 in-flight request at a time.
  private queue: Promise<void> = Promise.resolve();

  private getWorkerConfig(): { workerPath: string; execArgv: string[] } {
    const tsWorkerPath = path.join(__dirname, "worker.ts");
    const jsWorkerPath = path.join(__dirname, "worker.js");
    const hasTsWorker = fs.existsSync(tsWorkerPath);
    const hasJsWorker = fs.existsSync(jsWorkerPath);
    const runningTs = path.extname(__filename) === ".ts";
    const isDev = (runningTs && hasTsWorker) || (hasTsWorker && !hasJsWorker);

    if (isDev) {
      return { workerPath: tsWorkerPath, execArgv: ["-r", "ts-node/register"] };
    }
    return { workerPath: jsWorkerPath, execArgv: [] };
  }

  private createWorker(): Worker {
    const { workerPath, execArgv } = this.getWorkerConfig();
    const worker = new Worker(workerPath, { execArgv });

    worker.on("message", (message) => this.handleMessage(message));
    worker.on("error", (err) => {
      console.error("Worker error:", err);
      // If the worker errors out, we should probably restart it or at least reject pending
      // But let's rely on 'exit' to handle the cleanup/restart logic if it crashes.
      // Just reject pending requests here.
      this.rejectAll(err instanceof Error ? err : new Error(String(err)));
    });
    worker.on("exit", (code) => {
      if (!this.isClosing && code !== 0) {
        console.error(`Worker crashed (code ${code}). It will auto-restart on next request.`);
        this.rejectAll(new Error(`Worker exited with code ${code}`));
      }
      this.worker = null;
    });

    return worker;
  }

  private async restartWorker(reason: string) {
    if (this.isClosing) return;
    console.warn(`[WorkerManager] Restarting worker: ${reason}`);

    // 1. Force kill the old worker
    if (this.worker) {
      this.worker.removeAllListeners(); // Prevent "exit" handler from firing and logging "crashed"
      await this.worker.terminate();
      this.worker = null;
    }

    // 2. Reject any pending requests (they are lost)
    // We could retry them, but for now, fail fast is safer to avoid death loops.
    this.rejectAll(new Error(`Worker restarted: ${reason}`));

    // 3. Create a new worker immediately (so it's ready)
    this.ensureWorker();
  }

  private handleMessage(message: any) {
    const { id, hybrids, query, error, memory } = message;
    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    if (pending.timeoutId) clearTimeout(pending.timeoutId);

    if (error) pending.reject(new Error(error));
    else if (hybrids !== undefined) pending.resolve(hybrids);
    else if (query !== undefined) pending.resolve(query);
    else pending.resolve(undefined);

    this.pendingRequests.delete(id);

    // Check memory usage
    if (memory && memory.rss) {
      const rssMb = Math.round(memory.rss / 1024 / 1024);
      if (rssMb > MAX_WORKER_MEMORY_MB) {
        // Trigger restart asynchronously to let the current stack unwind
        setTimeout(() => {
          this.restartWorker(`Memory limit exceeded (${rssMb}MB > ${MAX_WORKER_MEMORY_MB}MB)`);
        }, 100);
      }
    }
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = this.createWorker();
    }
    return this.worker;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.isClosing) {
      return Promise.reject(new Error("WorkerManager is closing"));
    }

    const run = this.queue.then(task, task);

    // Keep the queue alive even if this task fails.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  private async sendToWorkerUnqueued<T>(
    buildPayload: (id: string) => WorkerRequest,
  ): Promise<T> {
    const worker = this.ensureWorker();

    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const payload = buildPayload(id);

      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          const err = new Error(`Worker request timed out after ${WORKER_TIMEOUT_MS}ms`);
          reject(err);
          // If it timed out, the worker is likely stuck. Kill it.
          this.restartWorker("Request timeout");
        }
      }, WORKER_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject: reject as (reason: unknown) => void,
        timeoutId,
      });

      worker.postMessage(payload);
    });
  }

  private async sendToWorker<T>(
    buildPayload: (id: string) => WorkerRequest,
  ): Promise<T> {
    return this.enqueue(() => this.sendToWorkerUnqueued<T>(buildPayload));
  }

  async computeHybrid(
    texts: string[],
  ): Promise<Array<{ dense: number[]; colbert: Buffer; scale: number }>> {
    return this.sendToWorker((id) => ({ id, hybrid: { texts } }));
  }

  async encodeQuery(
    text: string,
  ): Promise<{ dense: number[]; colbert: number[][]; colbertDim: number }> {
    return this.sendToWorker((id) => ({ id, query: { text } }));
  }

  async close(): Promise<void> {
    this.isClosing = true;

    // Let any queued task finish or fail, then shutdown.
    try {
      await this.queue;
    } catch {
      // ignore
    }

    try {
      this.worker?.postMessage({ type: "shutdown" } satisfies WorkerRequest);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      // ignore
    }

    try {
      if (this.worker) {
        await this.worker.terminate();
      }
    } catch {
      // ignore
    } finally {
      this.worker = null;
      this.pendingRequests.clear();
      this.queue = Promise.resolve();
    }
  }
}

export const workerManager = new WorkerManager();
