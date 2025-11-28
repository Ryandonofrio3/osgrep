import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { Binary, Bool, Field, FixedSizeList, Float32, Float64, Int32, Utf8, Schema } from "apache-arrow";
import { v4 as uuidv4 } from "uuid";
import type {
  ChunkType,
  CreateStoreOptions,
  IndexFileOptions,
  PreparedChunk,
  SearchFilter,
  SearchResponse,
  Store,
  StoreFile,
  StoreInfo,
  VectorRecord,
} from "./store";
import { TreeSitterChunker } from "./chunker";
import {
  buildAnchorChunk,
  ChunkWithContext,
  formatChunkText,
} from "./chunk-utils";
import { workerManager } from "./worker-manager";
import { CONFIG } from "../config";
import { maxSim } from "./colbert-math";

const PROFILE_ENABLED =
  process.env.OSGREP_PROFILE === "1" || process.env.OSGREP_PROFILE === "true";

export interface LocalStoreProfile {
  listFilesMs: number;
  indexCount: number;
  totalChunkCount: number;
  totalChunkTimeMs: number;
  totalTableWriteMs: number;
}

export class LocalStore implements Store {
  private db: lancedb.Connection | null = null;
  private chunker = new TreeSitterChunker();
  private readonly VECTOR_DIMENSIONS = CONFIG.VECTOR_DIMENSIONS;
  private readonly queryPrefix = CONFIG.QUERY_PREFIX;
  private readonly colbertDim = CONFIG.COLBERT_DIM;
  private profile: LocalStoreProfile = {
    listFilesMs: 0,
    indexCount: 0,
    totalChunkCount: 0,
    totalChunkTimeMs: 0,
    totalTableWriteMs: 0,
  };

  constructor() {
    // Initialize chunker in background (it might download WASMs)
    this.chunker
      .init()
      .catch((err) => console.error("Failed to init chunker:", err));
  }

  private isNodeReadable(input: unknown): input is NodeJS.ReadableStream {
    return (
      typeof input === "object" &&
      input !== null &&
      typeof (input as NodeJS.ReadableStream)[Symbol.asyncIterator] ===
      "function"
    );
  }

  private async getDb(): Promise<lancedb.Connection> {
    if (!this.db) {
      const dbPath = path.join(os.homedir(), ".osgrep", "data");
      if (!fs.existsSync(dbPath)) {
        fs.mkdirSync(dbPath, { recursive: true });
      }
      this.db = await lancedb.connect(dbPath);
    }
    return this.db;
  }

  private async getTable(storeId: string): Promise<lancedb.Table> {
    return this.ensureTable(storeId);
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
      context_prev: "",
      context_next: "",
      chunk_type: "",
      vector: Array(this.VECTOR_DIMENSIONS).fill(0),
      colbert: Buffer.alloc(0),
      colbert_scale: 1,
    };
  }

  private normalizeVector(vector: unknown): number[] {
    const source =
      Array.isArray(vector) && vector.every((v) => typeof v === "number")
        ? (vector as number[])
        : ArrayBuffer.isView(vector)
          ? Array.from(vector as unknown as ArrayLike<number>)
          : [];
    const trimmed = source.slice(0, this.VECTOR_DIMENSIONS);
    if (trimmed.length < this.VECTOR_DIMENSIONS) {
      trimmed.push(...Array(this.VECTOR_DIMENSIONS - trimmed.length).fill(0));
    }
    return trimmed;
  }

  private async ensureTable(storeId: string): Promise<lancedb.Table> {
    const db = await this.getDb();
    const schema = new Schema([
      new Field("id", new Utf8(), false),
      new Field("path", new Utf8(), false),
      new Field("hash", new Utf8(), false),
      new Field("content", new Utf8(), false),
      new Field("start_line", new Int32(), false),
      new Field("end_line", new Int32(), false),
      new Field(
        "vector",
        new FixedSizeList(
          this.VECTOR_DIMENSIONS,
          new Field("item", new Float32(), false),
        ),
        false,
      ),
      new Field("chunk_index", new Int32(), true),
      new Field("is_anchor", new Bool(), true),
      new Field("context_prev", new Utf8(), true),
      new Field("context_next", new Utf8(), true),
      new Field("chunk_type", new Utf8(), true),
      new Field("colbert", new Binary(), true),
      new Field("colbert_scale", new Float64(), true),
    ]);

    try {
      const table = await db.openTable(storeId);

      // Check for schema/dimension mismatch without loading all rows
      // We just peek at one row to verify vector dimensions
      let needsMigration = false;
      try {
        const sample = (await table.query().limit(1).toArray()) as VectorRecord[];
        if (sample.length > 0) {
          const sampleVectorLength =
            Array.isArray(sample[0].vector)
              ? (sample[0].vector as number[]).length
              : 0;
          if (
            sampleVectorLength > 0 &&
            sampleVectorLength !== this.VECTOR_DIMENSIONS
          ) {
            needsMigration = true;
          }
        }
      } catch {
        // If query fails, assume we might need migration or table is empty
      }

      if (!needsMigration) {
        return table;
      }

      // If we need migration, we have to do it carefully (batching) or just drop if it's too complex for now.
      // The original code dropped and recreated, but loaded everything into RAM first.
      // For safety in this hardening phase, if we detect a dimension mismatch, we will DROP the table
      // because re-indexing is safer than trying to migrate incompatible vectors in-memory.
      // Users will just have to re-index.
      console.warn(`[osgrep] Schema mismatch detected for ${storeId}. Recreating table...`);

      try {
        await db.dropTable(storeId);
      } catch {
        // If drop fails, attempt recreate will throw below
      }

      const newTable = await db.createTable(storeId, [this.baseSchemaRow()], {
        schema,
      });
      await newTable.delete('id = "seed"');
      return newTable;
    } catch (err) {
      try {
        const table = await db.createTable(storeId, [this.baseSchemaRow()], {
          schema,
        });
        await table.delete('id = "seed"');
        return table;
      } catch (createErr) {
        // If the table already exists, open it instead of failing the flow
        const message =
          createErr instanceof Error ? createErr.message : String(createErr);
        if (message.toLowerCase().includes("already exists")) {
          const table = await db.openTable(storeId);
          return table;
        }
        throw createErr;
      }
    }
  }

  async *listFiles(storeId: string): AsyncGenerator<StoreFile> {
    const start = PROFILE_ENABLED ? process.hrtime.bigint() : null;
    try {
      const table = await this.getTable(storeId);
      // This is a simplification; ideally we'd group by file path
      // For now, let's just return unique paths
      let results: VectorRecord[] = [];
      try {
        results = (await table
          .query()
          .where("is_anchor = true")
          .select(["path", "hash"])
          .toArray()) as VectorRecord[];
      } catch {
        // Fallback for legacy tables without is_anchor
        results = (await table.query().select(["path", "hash"]).toArray()) as VectorRecord[];
      }

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
    _storeId: string,
    file: File | ReadableStream | NodeJS.ReadableStream | string,
    options: IndexFileOptions,
  ): Promise<PreparedChunk[]> {
    const fileIndexStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
    let fileChunkMs = 0;


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
        return [];
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
      // Calculate chunking time only
      fileChunkMs += Number(chunkEnd - chunkStart) / 1_000_000;
      this.profile.totalChunkTimeMs += fileChunkMs;
      this.profile.totalChunkCount += parsedChunks.length;
    }

    const anchorChunk = buildAnchorChunk(
      options.metadata?.path || "unknown",
      content,
    );

    const baseChunks = anchorChunk
      ? [anchorChunk, ...parsedChunks]
      : parsedChunks;

    if (baseChunks.length === 0) return [];

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
      formatChunkText(chunk, options.metadata?.path || ""),
    );

    const pendingWrites: PreparedChunk[] = [];

    for (let i = 0; i < chunkTexts.length; i++) {
      const chunk = chunks[i];
      const prev = chunkTexts[i - 1];
      const next = chunkTexts[i + 1];

      pendingWrites.push({
        id: uuidv4(),
        path: options.metadata?.path || "",
        hash: options.metadata?.hash || "",
        content: chunkTexts[i],
        context_prev: typeof prev === "string" ? prev : undefined,
        context_next: typeof next === "string" ? next : undefined,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        chunk_index: chunk.chunkIndex,
        is_anchor: chunk.isAnchor === true,
        // This is the critical field for Structural Boosting
        chunk_type: typeof chunk.type === "string" ? chunk.type : undefined,
      });
    }

    if (PROFILE_ENABLED && fileIndexStart) {
      const end = process.hrtime.bigint();
      this.profile.indexCount += 1;
      const total = Number(end - fileIndexStart) / 1_000_000;
      // Note: We removed embedTime and deleteTime from this log since they don't happen here anymore
      console.log(
        `[profile] index ${options.metadata?.path ?? "unknown"} • chunks=${chunks.length
        } chunkTime=${fileChunkMs.toFixed(1)}ms total=${total.toFixed(1)}ms`,
      );
    }

    return pendingWrites;
  }

  async insertBatch(storeId: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    const sanitizeRecord = (rec: VectorRecord): VectorRecord => {
      const vecArray =
        typeof rec.vector?.toString === "function" && !Array.isArray(rec.vector)
          ? Array.from(rec.vector as ArrayLike<number>)
          : Array.isArray(rec.vector)
            ? (rec.vector as number[])
            : [];
      const normalizedVector = this.normalizeVector(vecArray);

      const colBuffer = Buffer.isBuffer(rec.colbert)
        ? rec.colbert
        : Array.isArray(rec.colbert)
          ? Buffer.from(new Int8Array(rec.colbert as number[]))
          : ArrayBuffer.isView(rec.colbert)
            ? Buffer.from(new Int8Array(Array.from(rec.colbert as ArrayLike<number>)))
            : Buffer.alloc(0);

      return {
        ...rec,
        vector: Array.from(normalizedVector),
        colbert: Buffer.from(new Uint8Array(colBuffer)),
        colbert_scale:
          typeof rec.colbert_scale === "number" ? rec.colbert_scale : 1,
      };
    };

    const sanitized = records.map(sanitizeRecord);

    if (process.env.OSGREP_DEBUG_EMBED === "1" && sanitized.length > 0) {
      const v = sanitized[0].vector;
      const c = sanitized[0].colbert;
      const sum = v.slice(0, 10).reduce((acc, x) => acc + x, 0);
      console.log(
        `[debug] insertBatch first vec sum10=${sum.toFixed(4)} first5=${v.slice(0, 5).map((x) => x.toFixed(4))} colbert_len=${c.length} colbert_first5=${c.slice(0, 5)}`,
      );
    }

    const table = await this.ensureTable(storeId);
    const writeStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
    await table.add(sanitized);
    if (process.env.OSGREP_DEBUG_EMBED === "1") {
      try {
        const sample = await table.query().limit(1).toArray();
        const vecSample = sample[0]?.vector;
        const vecArrRaw =
          vecSample && typeof (vecSample as { toArray?: () => number[] }).toArray === "function"
            ? (vecSample as { toArray: () => number[] }).toArray()
            : (vecSample as unknown as ArrayLike<number>);
        const vecArr = Array.isArray(vecArrRaw)
          ? vecArrRaw
          : ArrayBuffer.isView(vecArrRaw)
            ? Array.from(vecArrRaw as ArrayLike<number>)
            : [];
        const sumStored = vecArr.slice(0, 10).reduce((acc, x) => acc + x, 0);
        console.log(
          `[debug] stored first vec sum10=${sumStored.toFixed(4)}`,
        );
      } catch (err) {
        console.warn("[debug] failed to read back sample:", err);
      }
    }
    if (PROFILE_ENABLED && writeStart) {
      const writeEnd = process.hrtime.bigint();
      this.profile.totalTableWriteMs +=
        Number(writeEnd - writeStart) / 1_000_000;
    }
  }

  async createFTSIndex(storeId: string): Promise<void> {
    const table = await this.getTable(storeId);
    try {
      // LanceDB requires explicit config for FTS
      await table.createIndex("content", {
        config: lancedb.Index.fts(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("already exists")) {
        console.warn("Failed to create FTS index:", e);
      }
    }
  }

  async createVectorIndex(storeId: string): Promise<void> {
    const table = await this.getTable(storeId);

    // Guard against small tables - flat search is faster and avoids noisy k-means warnings
    const rowCount = await table.countRows();
    if (rowCount < 4000) {
      return;
    }

    try {
      const numPartitions = Math.max(
        8,
        Math.min(64, Math.floor(rowCount / 100)),
      );
      const vectorIndexOptions: Record<string, unknown> = {
        type: "ivf_flat",
        num_partitions: numPartitions,
      };
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

  private mapRecordToChunk(record: VectorRecord, score: number): ChunkType {
    const contextPrev =
      typeof record.context_prev === "string" ? record.context_prev : "";
    const contextNext =
      typeof record.context_next === "string" ? record.context_next : "";
    const fullText = `${contextPrev}${record.content ?? ""}${contextNext}`;
    const startLine = (record.start_line as number) ?? 0;
    const endLine = (record.end_line as number) ?? startLine;
    const chunkType =
      typeof (record as { chunk_type?: unknown }).chunk_type === "string"
        ? ((record as { chunk_type?: string }).chunk_type as string)
        : undefined;

    return {
      type: "text",
      text: fullText,
      score,
      metadata: {
        path: record.path as string,
        hash: (record.hash as string) || "",
        is_anchor: record.is_anchor === true,
      },
      generated_metadata: {
        start_line: startLine,
        num_lines: Math.max(1, endLine - startLine + 1),
        type: chunkType,
      },
    };
  }

  private applyStructureBoost(record: VectorRecord, score: number): number {
    let adjusted = score;
    const chunkType =
      typeof (record as { chunk_type?: unknown }).chunk_type === "string"
        ? ((record as { chunk_type?: string }).chunk_type as string)
        : "";
    const boosted = ["function", "class", "method", "interface", "type_alias"];
    if (boosted.includes(chunkType)) {
      adjusted *= 1.25;
    }
    const pathStr =
      typeof record.path === "string" ? record.path.toLowerCase() : "";
    if (
      pathStr.includes(".test.") ||
      pathStr.includes(".spec.") ||
      pathStr.includes("__tests__")
    ) {
      adjusted *= 0.85;
    }
    if (
      pathStr.endsWith(".md") ||
      pathStr.endsWith(".mdx") ||
      pathStr.endsWith(".txt") ||
      pathStr.endsWith(".json") ||
      pathStr.endsWith(".lock") ||
      pathStr.includes("/docs/")
    ) {
      adjusted *= 0.5;
    }
    return adjusted;
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

    const finalLimit = top_k ?? 10;

    // 1. Dense + ColBERT query encoding
    const queryEnc = await workerManager.encodeQuery(
      this.queryPrefix + query,
    );
    const queryVector = queryEnc.dense;
    const doRerank = _search_options?.rerank !== false;

    // Check for dimension mismatch
    if (queryEnc.colbertDim && queryEnc.colbertDim !== this.colbertDim) {
      console.warn(
        `[osgrep] Warning: Model dimension mismatch. Config: ${this.colbertDim}, Model: ${queryEnc.colbertDim}. Scores may be inaccurate.`,
      );
    }

    // Optional path filter support
    const allFilters = Array.isArray((_filters as { all?: unknown })?.all)
      ? ((_filters as { all?: unknown }).all as Record<string, unknown>[])
      : [];
    const pathFilterEntry = allFilters.find(
      (f) => f?.key === "path" && f?.operator === "starts_with",
    );
    const pathPrefix =
      typeof pathFilterEntry?.value === "string" ? pathFilterEntry.value : "";

    const whereClause = pathPrefix
      ? `path LIKE '${pathPrefix.replace(/'/g, "''").replace(/\\/g, "\\\\")}%'`
      : undefined;

    // 2. HYBRID RECALL - THE "SQL SPLIT" STRATEGY
    // We force the database to give us Code, even if it thinks Docs are better.

    // Definitions of what counts as a "Doc"
    const docClause = "(path LIKE '%.md' OR path LIKE '%.mdx' OR path LIKE '%.txt' OR path LIKE '%.json')";
    const codeClause = `NOT ${docClause}`;

    // A. Search Code (High Priority - Get 300)
    const codeQuery = table.search(queryVector)
      .where(whereClause ? `${whereClause} AND ${codeClause}` : codeClause)
      .limit(100);

    // B. Search Docs (Low Priority - Get 50)
    const docQuery = table.search(queryVector)
      .where(whereClause ? `${whereClause} AND ${docClause}` : docClause)
      .limit(100);

    // C. FTS Search (Get 50)
    // Note: LanceDB FTS requires a string argument to search()
    let ftsPromise: Promise<VectorRecord[]> = Promise.resolve([]);
    try {
      let ftsQuery = table.search(query);
      if (whereClause) {
        ftsQuery = ftsQuery.where(whereClause);
      }
      ftsPromise = (ftsQuery.limit(100).toArray() as Promise<VectorRecord[]>).catch((e) => {
        console.warn("FTS search failed (index missing?):", e instanceof Error ? e.message : String(e));
        return [];
      });
    } catch (e) {
      // FTS might fail if index doesn't exist or other issues
      console.warn("FTS search failed, falling back to pure vector search", e);
    }

    // D. Run in Parallel
    const [codeResults, docResults, ftsResults] = await Promise.all([
      codeQuery.toArray() as Promise<VectorRecord[]>,
      docQuery.toArray() as Promise<VectorRecord[]>,
      ftsPromise,
    ]);

    // E. Merge & Deduplicate (Hybrid Pool)
    // We simply union the results. The RRF logic suggested by the user is implicitly handled
    // by the fact that we are about to rerank EVERYTHING using ColBERT.
    // RRF is typically used to select the top N candidates for reranking.
    // Since our N (400) is small enough for the reranker, we pass the full union.
    const denseCandidates = [...codeResults, ...docResults, ...ftsResults];

    // Deduplicate
    const candidatesMap = new Map<string, VectorRecord>();
    denseCandidates.forEach((r) => {
      const key = `${r.path}:${r.start_line}`;
      if (!candidatesMap.has(key)) candidatesMap.set(key, r);
    });
    const candidates = Array.from(candidatesMap.values());

    if (candidates.length === 0) {
      return { data: [] };
    }

    // Performance: We rerank all candidates from the hybrid pool (max 300).
    // MaxSim is O(N^2), but 300 is manageable and ensures we don't drop good FTS/Doc matches.
    const candidatesToRerank = candidates;

    // 3. Rerank (ColBERT + Structural Boosting)
    const queryMatrix = doRerank ? queryEnc.colbert : [];

    // 4. Offline MaxSim scoring (fallback to dense cosine if ColBERT payload is empty)
    const cosineSim = (a: number[], b: number[]) => {
      const dim = Math.min(a.length, b.length);
      let dot = 0;
      for (let i = 0; i < dim; i++) {
        dot += a[i] * b[i];
      }
      return dot;
    };

    const reranked = candidatesToRerank.map((doc) => {
      const denseVec = Array.isArray(doc.vector) ? (doc.vector as number[]) : [];
      let score = cosineSim(queryVector, denseVec);

      if (
        doRerank &&
        doc.colbert &&
        !(Array.isArray(doc.colbert) && doc.colbert.length === 0) &&
        queryMatrix.length > 0
      ) {
        const scale =
          typeof doc.colbert_scale === "number" ? doc.colbert_scale : 1.0;
        let int8: Int8Array | null = null;
        if (Buffer.isBuffer(doc.colbert)) {
          const buffer = doc.colbert as Buffer;
          int8 = new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        } else if (Array.isArray(doc.colbert)) {
          int8 = new Int8Array(doc.colbert as number[]);
        }

        if (int8) {
          const docMatrix: number[][] = [];
          // CRITICAL FIX: Always stride by the dimension used to STORE the data
          const stride = this.colbertDim;

          for (let i = 0; i < int8.length; i += stride) {
            const row: number[] = [];
            let isPadding = true;

            // Iterate up to the stored width
            for (let k = 0; k < stride; k++) {
              if (i + k >= int8.length) break;

              const val = (int8[i + k] / 127) * scale;
              if (val !== 0) isPadding = false;

              row.push(val);
            }
            if (!isPadding) {
              docMatrix.push(row);
            }
          }

          if (docMatrix.length > 0) {
            score = maxSim(queryMatrix, docMatrix);
          }
        }
      }

      score = this.applyStructureBoost(doc, score);

      return { record: doc, score };
    });

    return {
      data: reranked
        .sort((a, b) => b.score - a.score)
        .slice(0, finalLimit)
        .map((x) => this.mapRecordToChunk(x.record, x.score)),
    };
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

  async deleteFiles(storeId: string, filePaths: string[]): Promise<void> {
    const unique = Array.from(new Set(filePaths));
    if (unique.length === 0) return;

    const table = await this.getTable(storeId);
    const chunks: string[][] = [];
    const batchSize = 900;
    for (let i = 0; i < unique.length; i += batchSize) {
      chunks.push(unique.slice(i, i + batchSize));
    }

    for (const batch of chunks) {
      const safe = batch.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
      await table.delete(`path IN (${safe})`);
    }
  }

  async deleteStore(storeId: string): Promise<void> {
    const db = await this.getDb();
    try {
      await db.dropTable(storeId);
    } catch {
      // Table might not exist, which is fine
    }
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
    try {
      await workerManager.close();
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
