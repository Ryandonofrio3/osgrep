import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as lancedb from "@lancedb/lancedb";
import { v4 as uuidv4 } from "uuid";
import type {
  ChunkType,
  CreateStoreOptions,
  IndexFileOptions,
  SearchFilter,
  SearchResponse,
  Store,
  StoreFile,
  StoreInfo,
} from "./store";
import { type Chunk, TreeSitterChunker } from "./chunker";
import { LRUCache } from "./lru";
import { VECTOR_CACHE_MAX, WORKER_TIMEOUT_MS } from "../config";

type WorkerRequest =
  | { id: string; text: string }
  | { id: string; texts: string[] }
  | { id: string; rerank: { query: string; documents: string[] } };

const DB_PATH = path.join(os.homedir(), ".osgrep", "data");

type VectorRecord = {
  id: string;
  path: string;
  hash: string;
  content: string;
  start_line: number;
  end_line: number;
  vector: number[];
  chunk_index?: number;
  is_anchor?: boolean;
} & Record<string, unknown>;

type ChunkWithContext = Chunk & {
  context: string[];
  chunkIndex?: number;
  isAnchor?: boolean;
};
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  payload: WorkerRequest;
  timeoutId?: NodeJS.Timeout;
};

const PROFILE_ENABLED =
  process.env.OSGREP_PROFILE === "1" || process.env.OSGREP_PROFILE === "true";

export interface LocalStoreProfile {
  listFilesMs: number;
  indexCount: number;
  totalChunkCount: number;
  totalEmbedBatches: number;
  totalChunkTimeMs: number;
  totalEmbedTimeMs: number;
  totalTableWriteMs: number;
  totalTableDeleteMs: number;
}

export class LocalStore implements Store {
  private db: lancedb.Connection | null = null;
  private worker!: Worker;
  private vectorCache = new LRUCache<string, number[]>(VECTOR_CACHE_MAX);
  private pendingRequests = new Map<string, PendingRequest>();
  private restartInFlight: Promise<void> | null = null;
  private isClosing = false;
  private readonly MAX_WORKER_RSS = 6 * 1024 * 1024 * 1024; // 6GB upper bound, we restart before OOM
  private embedQueue: Promise<void> = Promise.resolve();
  private chunker = new TreeSitterChunker();
  private readonly VECTOR_DIMENSIONS = 384;
  private readonly EMBED_BATCH_SIZE = 12; // Smaller batches to tame thermals/memory on large repos
  private readonly WRITE_BATCH_SIZE = 50;
  private readonly queryPrefix =
    "Represent this sentence for searching relevant passages: ";
  private profile: LocalStoreProfile = {
    listFilesMs: 0,
    indexCount: 0,
    totalChunkCount: 0,
    totalEmbedBatches: 0,
    totalChunkTimeMs: 0,
    totalEmbedTimeMs: 0,
    totalTableWriteMs: 0,
    totalTableDeleteMs: 0,
  };

  constructor() {
    this.initializeWorker();
    // Initialize chunker in background (it might download WASMs)
    this.chunker
      .init()
      .catch((err) => console.error("Failed to init chunker:", err));
  }

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

  private initializeWorker() {
    const { workerPath, execArgv } = this.getWorkerConfig();
    this.worker = new Worker(workerPath, { execArgv });

    this.worker.on("message", (message) => {
      const { id, vector, vectors, scores, error, memory } = message;
      const pending = this.pendingRequests.get(id);

      if (pending) {
        // Clear timeout if set
        if (pending.timeoutId) {
          clearTimeout(pending.timeoutId);
        }

        if (error) {
          pending.reject(new Error(error));
        } else if (vectors !== undefined) {
          pending.resolve(vectors);
        } else if (scores !== undefined) {
          pending.resolve(scores);
        } else {
          pending.resolve(vector);
        }
        this.pendingRequests.delete(id);
      }

      if (memory && memory.rss > this.MAX_WORKER_RSS) {
        console.warn(
          `Worker memory usage high (${Math.round(memory.rss / 1024 / 1024)}MB). Restarting...`,
        );
        void this.restartWorker("memory limit exceeded");
      }
    });

    // Handle worker errors
    this.worker.on("error", (err) => {
      console.error("Worker error:", err);
      void this.restartWorker(`worker error: ${err.message}`);
    });

    // Handle worker exit
    this.worker.on("exit", (code) => {
      // Only restart on unexpected exits (not graceful shutdowns)
      if (code !== 0 && !this.isClosing) {
        console.error(`Worker exited with code ${code}`);
        void this.restartWorker(`worker exit: code ${code}`);
      }
    });
  }

  private rejectAllPending(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async restartWorker(reason?: string) {
    if (this.restartInFlight) {
      return this.restartInFlight;
    }

    // Reject all pending requests - fail fast, recover on next request
    this.rejectAllPending(
      new Error(`Worker restarting: ${reason || "unknown reason"}`),
    );

    this.restartInFlight = (async () => {
      try {
        await this.worker.terminate();
      } catch (err) {
        console.error("Failed to terminate worker cleanly:", err);
      }
      this.initializeWorker();
      if (reason) {
        console.warn(`Worker restarted due to ${reason}`);
      }
    })();

    await this.restartInFlight;
    this.restartInFlight = null;
  }

  private isNodeReadable(input: unknown): input is NodeJS.ReadableStream {
    return (
      typeof input === "object" &&
      input !== null &&
      typeof (input as NodeJS.ReadableStream)[Symbol.asyncIterator] ===
        "function"
    );
  }

  private async enqueueEmbedding<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.embedQueue.then(async () => {
      if (this.restartInFlight) {
        await this.restartInFlight;
      }
      return fn();
    }, fn);
    // Ensure queue advances even if fn rejects
    this.embedQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async sendToWorker<T>(
    buildPayload: (id: string) => WorkerRequest,
  ): Promise<T> {
    if (this.restartInFlight) {
      await this.restartInFlight;
    }

    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const payload = buildPayload(id);

      // Set up timeout
      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          reject(
            new Error(`Worker request timed out after ${WORKER_TIMEOUT_MS}ms`),
          );
        }
      }, WORKER_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject: reject as (reason: unknown) => void,
        payload,
        timeoutId,
      });
      this.worker.postMessage(payload);
    });
  }

  private async getEmbeddings(texts: string[]): Promise<number[][]> {
    const neededIndices: number[] = [];
    const neededTexts: string[] = [];
    const results: number[][] = new Array(texts.length);

    // 1. Check Cache
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      // Using full text as key for correctness. V8 handles string keys efficiently.
      const cached = this.vectorCache.get(text);
      if (cached !== undefined) {
        results[i] = cached;
      } else {
        neededIndices.push(i);
        neededTexts.push(text);
      }
    }

    if (neededTexts.length === 0) {
      return results; // All cached!
    }

    // 2. Embed only what's missing
    const computedVectors = await this.enqueueEmbedding(() =>
      this.sendToWorker<number[][]>((id) => ({ id, texts: neededTexts })),
    );

    // 3. Fill results and update cache
    for (let i = 0; i < computedVectors.length; i++) {
      const originalIndex = neededIndices[i];
      const vector = computedVectors[i];
      const text = neededTexts[i];

      this.vectorCache.set(text, vector);
      results[originalIndex] = vector;
    }

    return results;
  }

  private async getEmbedding(text: string): Promise<number[]> {
    // Wrapper for single text to maintain compatibility where needed
    const results = await this.getEmbeddings([text]);
    return results[0];
  }

  private async rerankDocuments(
    query: string,
    documents: string[],
  ): Promise<number[]> {
    return this.enqueueEmbedding(() =>
      this.sendToWorker<number[]>((id) => ({
        id,
        rerank: { query, documents },
      })),
    );
  }

  private async getDb(): Promise<lancedb.Connection> {
    if (!this.db) {
      if (!fs.existsSync(DB_PATH)) {
        fs.mkdirSync(DB_PATH, { recursive: true });
      }
      this.db = await lancedb.connect(DB_PATH);
    }
    return this.db;
  }

  private async getTable(storeId: string): Promise<lancedb.Table> {
    const db = await this.getDb();
    return await db.openTable(storeId);
  }

  private async fetchNeighborChunk(
    table: lancedb.Table,
    path: string,
    chunkIndex: number,
  ): Promise<VectorRecord | null> {
    const safePath = path.replace(/'/g, "''");
    try {
      const res = (await table
        .query()
        .filter(`path = '${safePath}' AND chunk_index = ${chunkIndex}`)
        .limit(1)
        .toArray()) as VectorRecord[];
      return res[0] ?? null;
    } catch {
      return null;
    }
  }

  private async expandWithNeighbors(
    table: lancedb.Table,
    record: VectorRecord,
  ): Promise<VectorRecord> {
    const centerIndex =
      typeof record.chunk_index === "number" ? record.chunk_index : null;
    if (centerIndex === null || typeof record.path !== "string") return record;

    const neighborIndices = [centerIndex - 1, centerIndex + 1].filter(
      (i) => i >= 0,
    );
    const neighbors: VectorRecord[] = [];
    for (const idx of neighborIndices) {
      const neighbor = await this.fetchNeighborChunk(
        table,
        record.path,
        idx,
      );
      if (neighbor) neighbors.push(neighbor);
    }

    if (neighbors.length === 0) return record;

    const ordered = [...neighbors, record].sort((a, b) => {
      const ai = typeof a.chunk_index === "number" ? a.chunk_index : 0;
      const bi = typeof b.chunk_index === "number" ? b.chunk_index : 0;
      return ai - bi;
    });

    const combinedContent = ordered
      .map((r) => String(r.content ?? ""))
      .join("\n\n");
    const startLine = Math.min(
      ...ordered.map((r) => (r.start_line as number) ?? record.start_line ?? 0),
    );
    const endLine = Math.max(
      ...ordered.map((r) => (r.end_line as number) ?? record.end_line ?? 0),
    );

    return {
      ...record,
      content: combinedContent,
      start_line: startLine,
      end_line: endLine,
    };
  }

  private baseSchemaRow(): VectorRecord {
    return {
      id: "seed",
      path: "",
      hash: "",
      content: "",
      start_line: 0,
      end_line: 0,
      chunk_index: 0,
      is_anchor: false,
      vector: Array(this.VECTOR_DIMENSIONS).fill(0),
    };
  }

  private formatChunkText(chunk: ChunkWithContext, filePath: string): string {
    const breadcrumb = [...chunk.context];
    const fileLabel = `File: ${filePath || "unknown"}`;
    const hasFileLabel = breadcrumb.some(
      (entry) => typeof entry === "string" && entry.startsWith("File: "),
    );
    if (!hasFileLabel) {
      breadcrumb.unshift(fileLabel);
    }
    const header = breadcrumb.length > 0 ? breadcrumb.join(" > ") : fileLabel;
    return `${header}\n---\n${chunk.content}`;
  }

  private extractTopComments(lines: string[]): string[] {
    const comments: string[] = [];
    let inBlock = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (inBlock) {
        comments.push(line);
        if (trimmed.includes("*/")) inBlock = false;
        continue;
      }
      if (trimmed === "") {
        // allow blank lines at the top of the file
        comments.push(line);
        continue;
      }
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("#!") ||
        trimmed.startsWith("# ")
      ) {
        comments.push(line);
        continue;
      }
      if (trimmed.startsWith("/*")) {
        comments.push(line);
        if (!trimmed.includes("*/")) inBlock = true;
        continue;
      }
      break;
    }
    // Trim trailing blank lines from the captured comment block
    while (comments.length > 0 && comments[comments.length - 1].trim() === "") {
      comments.pop();
    }
    return comments;
  }

  private extractImports(lines: string[], limit = 200): string[] {
    const modules: string[] = [];
    for (const raw of lines.slice(0, limit)) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("import ")) {
        const fromMatch = trimmed.match(/from\s+["']([^"']+)["']/);
        const sideEffect = trimmed.match(/^import\s+["']([^"']+)["']/);
        const named = trimmed.match(/import\s+(?:\* as\s+)?([A-Za-z0-9_$]+)/);
        if (fromMatch?.[1]) modules.push(fromMatch[1]);
        else if (sideEffect?.[1]) modules.push(sideEffect[1]);
        else if (named?.[1]) modules.push(named[1]);
        continue;
      }
      const requireMatch = trimmed.match(/require\(\s*["']([^"']+)["']\s*\)/);
      if (requireMatch?.[1]) {
        modules.push(requireMatch[1]);
      }
    }
    return Array.from(new Set(modules));
  }

  private extractExports(lines: string[], limit = 200): string[] {
    const exports: string[] = [];
    for (const raw of lines.slice(0, limit)) {
      const trimmed = raw.trim();
      if (!trimmed.startsWith("export") && !trimmed.includes("module.exports"))
        continue;

      const decl = trimmed.match(
        /^export\s+(?:default\s+)?(class|function|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/,
      );
      if (decl?.[2]) {
        exports.push(decl[2]);
        continue;
      }

      const brace = trimmed.match(/^export\s+\{([^}]+)\}/);
      if (brace?.[1]) {
        const names = brace[1]
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean);
        exports.push(...names);
        continue;
      }

      if (trimmed.startsWith("export default")) {
        exports.push("default");
      }

      if (trimmed.includes("module.exports")) {
        exports.push("module.exports");
      }
    }
    return Array.from(new Set(exports));
  }

  private buildAnchorChunk(
    filePath: string,
    content: string,
  ): Chunk & { context: string[]; chunkIndex: number; isAnchor: boolean } {
    const lines = content.split("\n");
    const topComments = this.extractTopComments(lines);
    const imports = this.extractImports(lines);
    const exports = this.extractExports(lines);

    const preamble: string[] = [];
    let nonBlank = 0;
    let totalChars = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      preamble.push(line);
      nonBlank += 1;
      totalChars += line.length;
      if (nonBlank >= 30 || totalChars >= 1200) break;
    }

    const sections: string[] = [];
    sections.push(`File: ${filePath}`);
    if (imports.length > 0) {
      sections.push(`Imports: ${imports.join(", ")}`);
    }
    if (exports.length > 0) {
      sections.push(`Exports: ${exports.join(", ")}`);
    }
    if (topComments.length > 0) {
      sections.push(`Top comments:\n${topComments.join("\n")}`);
    }
    if (preamble.length > 0) {
      sections.push(`Preamble:\n${preamble.join("\n")}`);
    }
    sections.push("---");
    sections.push("(anchor)");

    const anchorText = sections.join("\n\n");
    const approxEndLine = Math.min(
      lines.length,
      Math.max(1, nonBlank || preamble.length || 5),
    );

    return {
      content: anchorText,
      startLine: 0,
      endLine: approxEndLine,
      type: "block",
      context: [`File: ${filePath}`, "Anchor"],
      chunkIndex: -1,
      isAnchor: true,
    };
  }

  private async ensureTable(storeId: string): Promise<lancedb.Table> {
    const db = await this.getDb();
    try {
      return await db.openTable(storeId);
    } catch {
      const table = await db.createTable(storeId, [this.baseSchemaRow()]);
      await table.delete('id = "seed"');
      return table;
    }
  }

  async *listFiles(storeId: string): AsyncGenerator<StoreFile> {
    const start = PROFILE_ENABLED ? process.hrtime.bigint() : null;
    try {
      const table = await this.getTable(storeId);
      // This is a simplification; ideally we'd group by file path
      // For now, let's just return unique paths
      const results = await table.query().select(["path", "hash"]).toArray();

      const seen = new Set<string>();
      for (const r of results) {
        if (!seen.has(r.path as string)) {
          seen.add(r.path as string);
          yield {
            external_id: r.path as string,
            metadata: {
              path: r.path as string,
              hash: (r.hash as string) || "",
            },
          };
        }
      }
    } catch (e) {
      // Table might not exist
    } finally {
      if (PROFILE_ENABLED && start) {
        const end = process.hrtime.bigint();
        this.profile.listFilesMs += Number(end - start) / 1_000_000;
      }
    }
  }

  async indexFile(
    storeId: string,
    file: File | ReadableStream | NodeJS.ReadableStream | string,
    options: IndexFileOptions,
  ): Promise<void> {
    const fileIndexStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
    let fileChunkMs = 0;
    let fileEmbedMs = 0;
    let fileDeleteMs = 0;
    let fileWriteMs = 0;
    const table = await this.ensureTable(storeId);

    // Read file content (prefer provided content to avoid double reads)
    let content = options.content ?? "";
    if (!content) {
      if (typeof file === "string") {
        content = file;
      } else if (this.isNodeReadable(file)) {
        for await (const chunk of file) {
          content += typeof chunk === "string" ? chunk : chunk.toString();
        }
      } else if (file instanceof ReadableStream) {
        const reader = file.getReader();
        let result = await reader.read();
        while (!result.done) {
          const value = result.value;
          content +=
            typeof value === "string"
              ? value
              : Buffer.from(value as ArrayBuffer).toString();
          result = await reader.read();
        }
      } else if (file instanceof File) {
        content = await file.text();
      } else {
        return;
      }
    }

    // Delete existing chunks for this file
    const safePath = options.metadata?.path?.replace(/'/g, "''");
    if (safePath) {
      const deleteStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
      await table.delete(`path = '${safePath}'`);
      if (PROFILE_ENABLED && deleteStart) {
        const deleteEnd = process.hrtime.bigint();
        this.profile.totalTableDeleteMs +=
          Number(deleteEnd - deleteStart) / 1_000_000;
        fileDeleteMs += Number(deleteEnd - deleteStart) / 1_000_000;
      }
    }

    // Use TreeSitterChunker
    const chunkStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
    const parsedChunks = await this.chunker.chunk(
      options.metadata?.path || "unknown",
      content,
    );
    if (PROFILE_ENABLED && chunkStart) {
      const chunkEnd = process.hrtime.bigint();
      this.profile.totalChunkTimeMs +=
        Number(chunkEnd - chunkStart) / 1_000_000;
      fileChunkMs += Number(chunkEnd - chunkStart) / 1_000_000;
      this.profile.totalChunkCount += parsedChunks.length;
    }
    const anchorChunk = this.buildAnchorChunk(
      options.metadata?.path || "unknown",
      content,
    );
    const baseChunks = anchorChunk
      ? [anchorChunk, ...parsedChunks]
      : parsedChunks;
    if (baseChunks.length === 0) return;

    const chunks: ChunkWithContext[] = baseChunks.map((chunk, idx) => {
      const chunkWithContext = chunk as ChunkWithContext;
      return {
        ...chunkWithContext,
        context: Array.isArray(chunkWithContext.context)
          ? chunkWithContext.context
          : [],
        chunkIndex:
          typeof chunkWithContext.chunkIndex === "number"
            ? chunkWithContext.chunkIndex
            : anchorChunk
              ? idx - 1
              : idx,
        isAnchor:
          chunkWithContext.isAnchor === true || (anchorChunk ? idx === 0 : false),
      };
    });
    this.profile.totalChunkCount += anchorChunk ? 1 : 0;

    const chunkTexts = chunks.map((chunk) =>
      this.formatChunkText(chunk, options.metadata?.path || ""),
    );

    const BATCH_SIZE = this.EMBED_BATCH_SIZE;
    const WRITE_BATCH_SIZE = this.WRITE_BATCH_SIZE;
    let pendingWrites: VectorRecord[] = [];

    for (let i = 0; i < chunkTexts.length; i += BATCH_SIZE) {
      const batchTexts = chunkTexts.slice(i, i + BATCH_SIZE);
      const embedStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
      const batchVectors = await this.getEmbeddings(batchTexts);
      if (PROFILE_ENABLED && embedStart) {
        const embedEnd = process.hrtime.bigint();
        this.profile.totalEmbedTimeMs +=
          Number(embedEnd - embedStart) / 1_000_000;
        fileEmbedMs += Number(embedEnd - embedStart) / 1_000_000;
        this.profile.totalEmbedBatches += 1;
      }
      for (let j = 0; j < batchVectors.length; j++) {
        const chunkIndex = i + j;
        const chunk = chunks[chunkIndex];
        const vector = batchVectors[j];

        pendingWrites.push({
          id: uuidv4(),
          path: options.metadata?.path || "",
          hash: options.metadata?.hash || "",
          content: chunkTexts[chunkIndex],
          start_line: chunk.startLine,
          end_line: chunk.endLine,
          chunk_index: chunk.chunkIndex,
          is_anchor: chunk.isAnchor === true,
          vector,
        });

        if (pendingWrites.length >= WRITE_BATCH_SIZE) {
          const writeStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
          await table.add(pendingWrites);
          if (PROFILE_ENABLED && writeStart) {
            const writeEnd = process.hrtime.bigint();
            this.profile.totalTableWriteMs +=
              Number(writeEnd - writeStart) / 1_000_000;
            fileWriteMs += Number(writeEnd - writeStart) / 1_000_000;
          }
          pendingWrites = [];
        }
      }
    }

    if (pendingWrites.length > 0) {
      const writeStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
      await table.add(pendingWrites);
      if (PROFILE_ENABLED && writeStart) {
        const writeEnd = process.hrtime.bigint();
        this.profile.totalTableWriteMs +=
          Number(writeEnd - writeStart) / 1_000_000;
        fileWriteMs += Number(writeEnd - writeStart) / 1_000_000;
      }
    }

    if (PROFILE_ENABLED && fileIndexStart) {
      const end = process.hrtime.bigint();
      this.profile.indexCount += 1;
      const total = Number(end - fileIndexStart) / 1_000_000;
      console.log(
        `[profile] index ${options.metadata?.path ?? "unknown"} • chunks=${
          chunks.length
        } batches=${Math.ceil(chunkTexts.length / BATCH_SIZE)} ` +
          `chunkTime=${fileChunkMs.toFixed(1)}ms embedTime=${fileEmbedMs.toFixed(1)}ms ` +
          `deleteTime=${fileDeleteMs.toFixed(1)}ms writeTime=${fileWriteMs.toFixed(1)}ms total=${total.toFixed(1)}ms`,
      );
    }
  }

  async createFTSIndex(storeId: string): Promise<void> {
    const table = await this.getTable(storeId);
    try {
      await table.createIndex("content");
    } catch (e) {
      console.warn("Failed to create FTS index (might already exist):", e);
    }
  }

  async createVectorIndex(storeId: string): Promise<void> {
    const table = await this.getTable(storeId);
    
    // Guard against small tables - LanceDB IVF_PQ requires 256 rows to train
    // If we have fewer, flat search is faster anyway and we avoid crashes
    const rowCount = await table.countRows();
    if (rowCount < 256) {
      return;
    }
    
    try {
      const vectorIndexOptions: Record<string, unknown> = { type: "ivf_flat" };
      await table.createIndex("vector", vectorIndexOptions);
    } catch (e) {
      const fallbackMsg = e instanceof Error ? e.message : String(e);
      if (!fallbackMsg.includes("already exists")) {
        try {
          await table.createIndex("vector");
        } catch (fallbackError) {
          const fallbackErr =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          if (!fallbackErr.includes("already exists")) {
            console.warn("Failed to create vector index:", fallbackError);
          }
        }
      }
    }
  }

  async search(
    storeId: string,
    query: string,
    top_k?: number,
    _search_options?: { rerank?: boolean },
    _filters?: SearchFilter,
  ): Promise<SearchResponse> {
    let table: lancedb.Table;
    try {
      table = await this.getTable(storeId);
    } catch {
      return { data: [] };
    }

    // 1. Setup
    const queryVector = await this.getEmbedding(this.queryPrefix + query);
    const finalLimit = top_k ?? 10;
    const totalChunks = await table.countRows();
    const candidateLimit = Math.min(400, Math.max(100, 2 * Math.sqrt(totalChunks)));

    const allFilters = Array.isArray(
      (_filters as { all?: unknown })?.all,
    )
      ? ((_filters as { all?: unknown }).all as Record<string, unknown>[])
      : [];
    const pathFilterEntry = allFilters.find(
      (f) => f?.key === "path" && f?.operator === "starts_with",
    );
    const pathPrefix =
      typeof pathFilterEntry?.value === "string" ? pathFilterEntry.value : "";

    // Build LanceDB WHERE clause for path filtering (applied BEFORE limit)
    const whereClause = pathPrefix
      ? `path LIKE '${pathPrefix.replace(/'/g, "''")}%'`
      : undefined;

    // 2. Parallel Retrieval: Vector + FTS 
    const vectorSearchQuery = table.search(queryVector).limit(candidateLimit);
    const ftsSearchQuery = table.search(query).limit(candidateLimit);

    if (whereClause) {
      vectorSearchQuery.where(whereClause);
      ftsSearchQuery.where(whereClause);
    }

    const [vectorResults, ftsResults] = await Promise.all([
      vectorSearchQuery.toArray() as Promise<VectorRecord[]>,
      ftsSearchQuery.toArray().catch(() => []) as Promise<VectorRecord[]>,
    ]);

    // 3. RRF Fusion (Combine the two lists)
    const k = 60; // RRF Constant
    const rrfScores = new Map<string, number>();
    const contentMap = new Map<string, VectorRecord>();

    const fuse = (results: VectorRecord[]) => {
      results.forEach((r, i) => {
        // Use path+start_line as unique key since ID might be unstable across re-indexes
        const key = `${r.path}:${r.start_line}`;
        if (!contentMap.has(key)) contentMap.set(key, r);

        const rank = i + 1;
        const score = 1 / (k + rank);
        rrfScores.set(key, (rrfScores.get(key) || 0) + score);
      });
    };

    fuse(vectorResults);
    fuse(ftsResults);

    // Sort by RRF Score to get the "Best of Both Worlds" candidates
    const candidates = Array.from(rrfScores.keys())
      .sort((a, b) => (rrfScores.get(b) || 0) - (rrfScores.get(a) || 0))
      .slice(0, candidateLimit) // Take top 50 combined
      .map((key) => contentMap.get(key))
      .filter((record): record is VectorRecord => Boolean(record));

    if (candidates.length === 0) {
      return { data: [] };
    }

    // 4. Neural Reranking (The Brains) + score blending
    const rrfValues = Array.from(rrfScores.values());
    const maxRrf = rrfValues.length > 0 ? Math.max(...rrfValues) : 0;
    const normalizeRrf = (key: string) =>
      maxRrf > 0 ? (rrfScores.get(key) || 0) / maxRrf : 0;

    let finalResults = candidates.map((r) => {
      const key = `${r.path}:${r.start_line}`;
      const rrfScore = normalizeRrf(key);
      return { record: r, score: rrfScore, rrfScore, rerankScore: 0 };
    });

    try {
      const docs = candidates.map((r) => String(r.content ?? ""));
      const scores = await this.rerankDocuments(query, docs);

      // Update scores with Neural scores
      finalResults = candidates.map((r, i) => {
        const key = `${r.path}:${r.start_line}`;
        const rrfScore = normalizeRrf(key);
        const rerankScore = scores[i] ?? 0;
        const blendedScore = 0.7 * rerankScore + 0.3 * rrfScore;
        return { record: r, score: blendedScore, rrfScore, rerankScore };
      });
    } catch (e) {
      console.warn(
        "Reranker failed; falling back to blended RRF-only order:",
        e,
      );
    }

    // 5. Final Sort & Format
    finalResults.sort((a, b) => b.score - a.score);
    const limited = finalResults.slice(0, finalLimit);

    const expanded = await Promise.all(
      limited.map(async ({ record, score }) => {
        const withNeighbors = await this.expandWithNeighbors(table, record);
        return { record: withNeighbors, score };
      }),
    );
    const chunks: ChunkType[] = expanded.map(({ record, score }) => {
      const startLine = (record.start_line as number) ?? 0;
      const endLine = (record.end_line as number) ?? startLine;
      return {
        type: "text",
        text: record.content as string,
        score,
        metadata: {
          path: record.path as string,
          hash: (record.hash as string) || "",
          is_anchor: record.is_anchor === true, 
        },
        generated_metadata: {
          start_line: startLine,
          num_lines: endLine - startLine,
        },
      };
    });

    return { data: chunks };
  }
  async retrieve(storeId: string): Promise<unknown> {
    const table = await this.getTable(storeId);
    const tableInfo = table as { info?: () => unknown };
    return typeof tableInfo.info === "function" ? tableInfo.info() : true;
  }

  async create(options: CreateStoreOptions): Promise<unknown> {
    const table = await this.ensureTable(options.name);
    const tableInfo = table as { info?: () => unknown };
    return typeof tableInfo.info === "function" ? tableInfo.info() : true;
  }

  async deleteFile(storeId: string, filePath: string): Promise<void> {
    const table = await this.getTable(storeId);
    const safePath = filePath.replace(/'/g, "''");
    await table.delete(`path = '${safePath}'`);
  }

  async getInfo(storeId: string): Promise<StoreInfo> {
    return {
      name: storeId,
      description: "Local Store",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      counts: {
        pending: 0,
        in_progress: 0,
      },
    };
  }

  getProfile(): LocalStoreProfile {
    return { ...this.profile };
  }

  async close(): Promise<void> {
    // Mark as closing to suppress error messages
    this.isClosing = true;
    
    // Clean shutdown: ask worker to exit gracefully, then terminate if needed
    try {
      // Send shutdown message
      this.worker.postMessage({ type: "shutdown" });
      // Give it a brief moment to exit cleanly
      await new Promise((resolve) => setTimeout(resolve, 100));
      await this.worker.terminate();
    } catch (err) {
      // Silent cleanup - worker may have already exited
    }
    if (this.db) {
      try {
        // LanceDB connections don't have an explicit close, but we null the ref
        this.db = null;
      } catch (err) {
        // Silent cleanup
      }
    }
  }
}
