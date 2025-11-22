import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as lancedb from "@lancedb/lancedb";
import { v4 as uuidv4 } from "uuid";
import type {
    AskResponse,
    ChunkType,
    CreateStoreOptions,
    SearchFilter,
    SearchResponse,
    Store,
    StoreFile,
    StoreInfo,
    UploadFileOptions,
} from "./store";

const DB_PATH = path.join(os.homedir(), ".osgrep", "data");

interface VectorRecord {
    id: string;
    path: string;
    hash: string;
    content: string;
    start_line: number;
    end_line: number;
    vector: number[];
    [key: string]: any;
}

import { TreeSitterChunker } from "./chunker";

export class LocalStore implements Store {
    private db: lancedb.Connection | null = null;
    private worker!: Worker;
    private pendingRequests = new Map<
        string,
        { resolve: (v: number[] | number[][]) => void; reject: (e: any) => void }
    >();
    private readonly MAX_WORKER_RSS = 1.5 * 1024 * 1024 * 1024; // restart only when truly high to avoid churn
    private embedQueue: Promise<void> = Promise.resolve();
    private chunker = new TreeSitterChunker();
    private readonly VECTOR_DIMENSIONS = 128;

    constructor() {
        this.initializeWorker();
        // Initialize chunker in background (it might download WASMs)
        this.chunker.init().catch(err => console.error("Failed to init chunker:", err));
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
            const { id, vector, vectors, error, memory } = message;
            const pending = this.pendingRequests.get(id);

            if (pending) {
                if (error) {
                    pending.reject(new Error(error));
                } else if (vectors) {
                    pending.resolve(vectors);
                } else {
                    pending.resolve(vector);
                }
                this.pendingRequests.delete(id);
            }

            if (memory && memory.rss > this.MAX_WORKER_RSS) {
                console.warn(`Worker memory usage high (${Math.round(memory.rss / 1024 / 1024)}MB). Restarting...`);
                this.restartWorker();
            }
        });
    }

    private async restartWorker() {
        // Reject anything still waiting on the old worker
        const pending = Array.from(this.pendingRequests.values());
        this.pendingRequests.clear();
        for (const { reject } of pending) {
            reject(new Error("Worker restarted"));
        }

        await this.worker.terminate();
        this.initializeWorker();
    }

    private async enqueueEmbedding<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.embedQueue.then(fn, fn);
        // Ensure queue advances even if fn rejects
        this.embedQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    private async getEmbeddings(texts: string[]): Promise<number[][]> {
        return this.enqueueEmbedding(
            () =>
                new Promise((resolve, reject) => {
                    const id = uuidv4();
                    this.pendingRequests.set(id, { resolve: resolve as any, reject });
                    this.worker.postMessage({ id, texts });
                }),
        );
    }

    private async getEmbedding(text: string): Promise<number[]> {
        // Wrapper for single text to maintain compatibility where needed
        const results = await this.getEmbeddings([text]);
        return results[0];
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

    private baseSchemaRow(): VectorRecord {
        return {
            id: "seed",
            path: "",
            hash: "",
            content: "",
            start_line: 0,
            end_line: 0,
            vector: Array(this.VECTOR_DIMENSIONS).fill(0),
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
        try {
            const table = await this.getTable(storeId);
            // This is a simplification; ideally we'd group by file path
            // For now, let's just return unique paths
            const results = await table
                .query()
                .select(["path", "hash"])
                .toArray();

            const seen = new Set<string>();
            for (const r of results) {
                if (!seen.has(r.path as string)) {
                    seen.add(r.path as string);
                    yield {
                        external_id: r.path as string,
                        metadata: { path: r.path as string, hash: (r.hash as string) || "" },
                    };
                }
            }
        } catch (e) {
            // Table might not exist
        }
    }

    async uploadFile(
        storeId: string,
        file: File | ReadableStream | any,
        options: UploadFileOptions,
    ): Promise<void> {
        const table = await this.ensureTable(storeId);

        // Read file content (prefer provided content to avoid double reads)
        let content = options.content ?? "";
        if (!content) {
            if (typeof file === "string") {
                content = file;
            } else if (file && typeof file.read === "function") {
                // It's a stream
                for await (const chunk of file) {
                    content += chunk;
                }
            } else if (file instanceof File) {
                content = await file.text();
            } else {
                // Fallback for now
                return;
            }
        }

        // Delete existing chunks for this file
        const safePath = options.metadata?.path?.replace(/'/g, "''");
        if (safePath) {
            await table.delete(`path = '${safePath}'`);
        }

        // Use TreeSitterChunker
        const chunks = await this.chunker.chunk(options.metadata?.path || "unknown", content);
        if (chunks.length === 0) return;

        const texts = chunks.map(c => c.content);

        // Batch embedding
        const vectors: number[][] = [];
        const BATCH_SIZE = 16;
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
            const batchTexts = texts.slice(i, i + BATCH_SIZE);
            const batchVectors = await this.getEmbeddings(batchTexts);
            vectors.push(...batchVectors);
        }

        const data: VectorRecord[] = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const vector = vectors[i];

            data.push({
                id: uuidv4(),
                path: options.metadata?.path || "",
                hash: options.metadata?.hash || "",
                content: chunk.content,
                start_line: chunk.startLine,
                end_line: chunk.endLine,
                vector,
            });
        }

        if (data.length > 0) {
            await table.add(data);
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
        try {
            // Try to create an optimized IVF_PQ index (requires 256+ chunks)
            await table.createIndex("vector", { type: "ivf_pq" } as any);
        } catch (e) {
            // Check if it's the "not enough rows" error - this is expected for small repos
            const errorMessage = e instanceof Error ? e.message : String(e);
            const isNotEnoughRows = errorMessage.includes("Not enough rows to train PQ") || 
                                   errorMessage.includes("Requires 256 rows");
            
            if (isNotEnoughRows) {
                // Silently fall back to a simpler index for small repos
                try {
                    await table.createIndex("vector");
                } catch (fallbackError) {
                    // Only warn if both attempts failed for a different reason
                    const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                    if (!fallbackMsg.includes("already exists")) {
                        console.warn("Note: Using basic vector index (repo has < 256 chunks). Performance will improve as you add more files.");
                    }
                }
            } else {
                // For other errors, try the simple index and warn if that fails too
                try {
                    await table.createIndex("vector");
                } catch (fallbackError) {
                    const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                    if (!fallbackMsg.includes("already exists")) {
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
        const queryVector = await this.getEmbedding(query);
        const k = 60; // RRF constant
        const limit = 50; // Fetch more candidates for fusion
        const pathFilter =
            (_filters as any)?.all?.find(
                (f: any) => f?.key === "path" && f?.operator === "starts_with",
            )?.value ?? "";
        const matchesFilter = (r: any) => {
            if (!pathFilter) return true;
            return typeof r.path === "string" && r.path.startsWith(pathFilter);
        };

        // 1. Vector Search
        const vectorResults = (await table
            .search(queryVector)
            .limit(limit)
            .toArray()).filter(matchesFilter);

        // 2. FTS Search
        let ftsResults: any[] = [];
        try {
            ftsResults = (await table
                .search(query)
                .limit(limit)
                .toArray()).filter(matchesFilter);
        } catch (e) {
            // FTS might fail if not indexed
        }

        // 3. RRF Fusion
        const scores = new Map<string, number>();
        const contentMap = new Map<string, any>();

        // Process Vector Results
        vectorResults.forEach((r, i) => {
            const id = r.id as string; // Assuming id is unique
            // If id is missing, use path+start_line
            const key = id || `${r.path}:${r.start_line}`;
            contentMap.set(key, r);
            const score = 1 / (k + i + 1);
            scores.set(key, (scores.get(key) || 0) + score);
        });

        // Process FTS Results
        ftsResults.forEach((r, i) => {
            const id = r.id as string;
            const key = id || `${r.path}:${r.start_line}`;
            if (!contentMap.has(key)) contentMap.set(key, r);
            const score = 1 / (k + i + 1);
            scores.set(key, (scores.get(key) || 0) + score);
        });

        // Sort by RRF score
        const sortedKeys = Array.from(scores.keys()).sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0));
        const topKeys = sortedKeys.slice(0, top_k || 10);

        const chunks: ChunkType[] = topKeys.map((key) => {
            const r = contentMap.get(key);
            return {
                type: "text",
                text: r.content as string,
                score: scores.get(key) || 0,
                metadata: { path: r.path as string, hash: "" },
                generated_metadata: {
                    start_line: r.start_line as number,
                    num_lines: (r.end_line as number) - (r.start_line as number),
                },
            };
        });

        return { data: chunks };
    }

    async retrieve(storeId: string): Promise<unknown> {
        const table = await this.getTable(storeId);
        return typeof (table as any).info === "function" ? (table as any).info?.() : true;
    }

    async create(options: CreateStoreOptions): Promise<unknown> {
        const table = await this.ensureTable(options.name);
        return typeof (table as any).info === "function" ? (table as any).info?.() : true;
    }

    async deleteFile(storeId: string, filePath: string): Promise<void> {
        const table = await this.getTable(storeId);
        const safePath = filePath.replace(/'/g, "''");
        await table.delete(`path = '${safePath}'`);
    }

    async ask(
        storeId: string,
        question: string,
        top_k?: number,
        _search_options?: { rerank?: boolean },
        _filters?: SearchFilter,
    ): Promise<AskResponse> {
        // Basic RAG implementation
        const searchRes = await this.search(storeId, question, top_k);
        const context = searchRes.data.map((c) => c.text).join("\n\n");

        // For now, just return the context as the answer since we don't have an LLM connected yet
        return {
            answer: "I found the following relevant code:\n\n" + context,
            sources: searchRes.data,
        };
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
}
