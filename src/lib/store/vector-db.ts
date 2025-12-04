import * as fs from "node:fs";
import * as lancedb from "@lancedb/lancedb";
import {
  Binary,
  Bool,
  Field,
  FixedSizeList,
  Float32,
  Float64,
  Int32,
  Schema,
  Utf8,
} from "apache-arrow";
import { CONFIG } from "../../config";
import { registerCleanup } from "../utils/cleanup";
import type { VectorRecord } from "./types";

const TABLE_NAME = "chunks";

export class VectorDB {
  private db: lancedb.Connection | null = null;
  private unregisterCleanup?: () => void;
  private closed = false;

  constructor(private lancedbDir: string) {
    this.unregisterCleanup = registerCleanup(() => this.close());
  }

  private async getDb(): Promise<lancedb.Connection> {
    if (this.closed) {
      throw new Error("VectorDB connection is closed");
    }
    if (!this.db) {
      fs.mkdirSync(this.lancedbDir, { recursive: true });
      this.db = await lancedb.connect(this.lancedbDir);
    }
    return this.db;
  }

  private seedRow(): VectorRecord {
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
      vector: Array(CONFIG.VECTOR_DIM).fill(0),
      colbert: Buffer.alloc(0),
      colbert_scale: 1,
      pooled_colbert_48d: Array(CONFIG.COLBERT_DIM).fill(0),
    };
  }

  private buildSchema(): Schema {
    return new Schema([
      new Field("id", new Utf8(), false),
      new Field("path", new Utf8(), false),
      new Field("hash", new Utf8(), false),
      new Field("content", new Utf8(), false),
      new Field("start_line", new Int32(), false),
      new Field("end_line", new Int32(), false),
      new Field(
        "vector",
        new FixedSizeList(
          CONFIG.VECTOR_DIM,
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
      new Field(
        "pooled_colbert_48d",
        new FixedSizeList(
          CONFIG.COLBERT_DIM,
          new Field("item", new Float32(), false),
        ),
        true,
      ),
    ]);
  }

  async ensureTable(): Promise<lancedb.Table> {
    const db = await this.getDb();
    try {
      return await db.openTable(TABLE_NAME);
    } catch (_err) {
      const schema = this.buildSchema();
      const table = await db.createTable(TABLE_NAME, [this.seedRow()], {
        schema,
      });
      const fieldNames =
        Array.isArray((table as any)?.schema?.fields) &&
          (table as any).schema.fields.length > 0
          ? (table as any).schema.fields.map((f: any) => f?.name)
          : [];
      console.log("[vector-db] created table with fields", fieldNames);
      await table.delete('id = "seed"');
      return table;
    }
  }

  async insertBatch(records: VectorRecord[]): Promise<void> {
    if (!records.length) return;
    const table = await this.ensureTable();
    const rows = records.map((rec) => {
      const vec = (() => {
        const arr = Array.from(rec.vector ?? []);
        if (arr.length < CONFIG.VECTOR_DIM) {
          arr.push(...Array(CONFIG.VECTOR_DIM - arr.length).fill(0));
        } else if (arr.length > CONFIG.VECTOR_DIM) {
          arr.length = CONFIG.VECTOR_DIM;
        }
        return arr;
      })();

      return {
        id: rec.id,
        path: rec.path,
        hash: rec.hash,
        content: rec.content,
        start_line: rec.start_line,
        end_line: rec.end_line,
        chunk_index: rec.chunk_index ?? null,
        is_anchor: rec.is_anchor ?? false,
        context_prev: rec.context_prev ?? "",
        context_next: rec.context_next ?? "",
        chunk_type: rec.chunk_type ?? "",
        vector: vec,
        colbert: Buffer.from(rec.colbert ?? []),
        colbert_scale: typeof rec.colbert_scale === "number" ? rec.colbert_scale : 1,
        pooled_colbert_48d: rec.pooled_colbert_48d
          ? Array.from(rec.pooled_colbert_48d)
          : undefined,
      };
    });

    try {
      await table.add(rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("found field not in schema")) {
        const schemaFields =
          Array.isArray((table as any)?.schema?.fields) &&
            (table as any).schema.fields.length > 0
            ? (table as any).schema.fields.map((f: any) => f?.name)
            : [];
        console.error("[vector-db] schema mismatch, dropping table. Fields:", schemaFields);
        await this.drop();
        this.db = null;
        const fresh = await this.ensureTable();
        await fresh.add(rows);
        return;
      }
      throw err;
    }
  }

  async createFTSIndex(): Promise<void> {
    const table = await this.ensureTable();
    try {
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

  async listPaths(): Promise<Map<string, string | undefined>> {
    const table = await this.ensureTable();
    const results = (await table
      .query()
      .select(["path", "hash"])
      .toArray()) as VectorRecord[];
    const byPath = new Map<string, string | undefined>();
    for (const r of results) {
      const key = r.path as string;
      if (!byPath.has(key)) {
        byPath.set(key, r.hash as string | undefined);
      }
    }
    return byPath;
  }

  async deletePaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const table = await this.ensureTable();
    const unique = Array.from(new Set(paths));
    const batchSize = 500;
    for (let i = 0; i < unique.length; i += batchSize) {
      const slice = unique.slice(i, i + batchSize);
      const values = slice.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
      await table.delete(`path IN (${values})`);
    }
  }

  async drop(): Promise<void> {
    const db = await this.getDb();
    try {
      await db.dropTable(TABLE_NAME);
    } catch (_err) {
      // ignore if missing
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unregisterCleanup?.();
    this.unregisterCleanup = undefined;
    const hasClose = typeof (this.db as any)?.close === "function";
    if (this.db && hasClose) {
      await (this.db as any).close();
    }
    this.db = null;
  }
}
