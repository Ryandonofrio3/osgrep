import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { v4 as uuidv4 } from "uuid";
import {
  MAX_WORKER_MEMORY_MB,
  WORKER_BOOT_TIMEOUT_MS,
  WORKER_TIMEOUT_MS,
} from "../config";

const PROFILE =
  process.env.OSGREP_PROFILE === "1" || process.env.OSGREP_PROFILE === "true";

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
  private consecutiveRecycles = 0; // Track recycles for same request
  private lastRequestId: string | null = null; // Track current request
  private requestsSinceRecycle = 0;
  private readonly RECYCLE_THRESHOLD = 100;
  private workerBooted = false;

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
    this.workerBooted = false;

    worker.on("message", (message) => this.handleMessage(message));
    worker.on("error", (err) => {
      console.error("Worker error:", err);
      // If the worker errors out, we MUST clean up the reference so the next request
      // spawns a fresh worker. We also try to terminate the underlying process.
      this.worker = null;
      try {
        worker.terminate();
      } catch {
        // Ignore termination errors
      }
      this.rejectAll(err instanceof Error ? err : new Error(String(err)));
    });
    worker.on("exit", (code) => {
      if (!this.isClosing && code !== 0) {
        console.error(`Worker crashed (code ${code}).`);
        // We don't reject all here anymore, because we have retry logic in sendToWorkerUnqueued.
        // But we should still clean up if there are pending requests that WON'T be retried?
        // Actually, if we rely on retry logic, we should just let the pending promise reject
        // so the retry loop catches it.
        this.rejectAll(new Error(`Worker exited with code ${code}`));
      }
      // Only clear if it matches our current worker (avoid race if we already spawned a new one)
      if (this.worker === worker) {
        this.worker = null;
        this.workerBooted = false;
      }
    });

    return worker;
  }

  private async recycleWorker(reason: string, requestId?: string) {
    if (this.isClosing || !this.worker) return;

    // Track consecutive recycles for the same request
    if (requestId && requestId === this.lastRequestId) {
      this.consecutiveRecycles++;
    } else {
      this.consecutiveRecycles = 1;
      this.lastRequestId = requestId || null;
    }

    // If we've recycled too many times for the same request, something is wrong
    if (this.consecutiveRecycles > 3) {
      console.error(
        `[WorkerManager] Too many recycles for the same request (${this.consecutiveRecycles}). Likely a file that's too large. Skipping.`,
      );
      this.consecutiveRecycles = 0;
      this.lastRequestId = null;
      // Reject the current request so it doesn't retry
      const pending = this.pendingRequests.get(requestId!);
      if (pending) {
        this.pendingRequests.delete(requestId!);
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        pending.reject(
          new Error(
            "Worker recycled too many times for this request. File may be too large.",
          ),
        );
      }
      return;
    }

    console.warn(
      `[WorkerManager] Recycling worker (attempt ${this.consecutiveRecycles}/3): ${reason}`,
    );

    // 1. Remove listeners so we don't trigger "crash" logic
    const oldWorker = this.worker;
    this.worker = null; // Next request will spawn new one
    this.workerBooted = false;
    oldWorker.removeAllListeners();

    // 2. Gracefully terminate
    await oldWorker.terminate();
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

    // First successful message marks worker as booted
    if (!this.workerBooted) {
      if (PROFILE) {
        console.log(`[WorkerManager] Worker booted successfully (req ${id})`);
      }
      this.workerBooted = true;
    }

    // Reset recycle counter on success
    if (id === this.lastRequestId) {
      this.consecutiveRecycles = 0;
      this.lastRequestId = null;
    }

    // Check memory usage
    if (memory && memory.rss) {
      const rssMb = Math.round(memory.rss / 1024 / 1024);
      if (rssMb > MAX_WORKER_MEMORY_MB) {
        // Recycle immediately since we are done with this request
        // and the queue ensures no other request is running.
        this.recycleWorker(
          `Memory limit exceeded (${rssMb}MB > ${MAX_WORKER_MEMORY_MB}MB)`,
          id,
        ).catch((err) => console.error("Failed to recycle worker:", err));
      }
    }

    // Proactive recycling to prevent slow leaks
    this.requestsSinceRecycle++;
    if (this.requestsSinceRecycle >= this.RECYCLE_THRESHOLD) {
      this.requestsSinceRecycle = 0;
      this.recycleWorker("Proactive recycle (request limit reached)").catch(
        (err) => console.error("Failed to recycle worker:", err),
      );
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
    const MAX_RETRIES = 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.attemptWorkerRequest<T>(buildPayload);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[WorkerManager] Request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastError.message}`);

        // If it was a timeout, we ALREADY killed the worker.
        // DO NOT RETRY TIMEOUTS. It's likely a poison pill payload.
        if (lastError.message.includes("timed out")) {
          throw lastError;
        }

        // If it was a crash, the exit handler cleared this.worker.
        // So next attempt will automatically spawn a new worker.

        if (attempt < MAX_RETRIES) {
          // Wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }
    throw lastError || new Error("Worker request failed after retries");
  }

  private attemptWorkerRequest<T>(
    buildPayload: (id: string) => WorkerRequest,
  ): Promise<T> {
    const worker = this.ensureWorker();
    const id = uuidv4();
    const message = buildPayload(id);
    const timeoutMs = this.workerBooted
      ? WORKER_TIMEOUT_MS
      : WORKER_BOOT_TIMEOUT_MS;

    if (PROFILE) {
      console.log(
        `[WorkerManager] Sending request ${id} (booted=${this.workerBooted}, timeout=${timeoutMs}ms)`,
      );
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          console.error(
            `[WorkerManager] Request ${id} timed out after ${timeoutMs}ms. Booted: ${this.workerBooted}`,
          );
          this.pendingRequests.delete(id);
          const err = new Error(
            `Worker request timed out after ${timeoutMs}ms`,
          );
          reject(err);
          // If it timed out, the worker is likely stuck. Kill it.
          this.recycleWorker("Request timeout", id).catch((err) =>
            console.warn("[WorkerManager] Failed to recycle worker on timeout:", err),
          );
        }
      }, timeoutMs);

      // Disable timeout recycling for the very first cold-boot request if explicitly desired?
      // For now, we trust the 5-minute BOOT_TIMEOUT to be enough.

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject: reject as (reason: unknown) => void,
        timeoutId,
      });

      worker.postMessage(message);
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

  async warmup(): Promise<void> {
    if (this.workerBooted) return;
    // Send a dummy request to trigger model loading
    await this.computeHybrid(["warmup"]);
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
