import * as fs from "node:fs";
import * as lancedb from "@lancedb/lancedb";
import {
  Binary,
  Bool,
  Field,
  FixedSizeList,
  Float32,
  Int32,
  List,
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
      display_text: "",
      start_line: 0,
      end_line: 0,
      chunk_index: 0,
      is_anchor: false,
      context_prev: "",
      context_next: "",
      chunk_type: "",
      complexity: 0,
      is_exported: false,
      vector: Array(CONFIG.VECTOR_DIM).fill(0),
      colbert: Buffer.alloc(0),
      doc_token_ids: [],
      defined_symbols: [],
      referenced_symbols: [],
      imports: [],
      exports: [],
      role: "",
      parent_symbol: "",
      file_skeleton: "",
    };
  }

  private async validateSchema(table: lancedb.Table) {
    const schema = await table.schema();
    const fields = new Set(schema.fields.map((f) => f.name));
    const required = ["complexity", "is_exported"];
    const missing = required.filter((r) => !fields.has(r));
    if (missing.length > 0) {
      throw new Error(
        `[vector-db] schema missing fields (${missing.join(
          ", ",
        )}). Please run "osgrep index --reset" to rebuild the index.`,
      );
    }
  }

  private buildSchema(): Schema {
    return new Schema([
      new Field("id", new Utf8(), false),
      new Field("path", new Utf8(), false),
      new Field("hash", new Utf8(), false),
      new Field("content", new Utf8(), false),
      new Field("display_text", new Utf8(), false),
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
      new Field("complexity", new Float32(), true),
      new Field("is_exported", new Bool(), true),
      new Field("colbert", new Binary(), true),
      new Field(
        "doc_token_ids",
        new List(new Field("item", new Int32(), true)),
        true,
      ),
      new Field(
        "defined_symbols",
        new List(new Field("item", new Utf8(), true)),
        true,
      ),
      new Field(
        "referenced_symbols",
        new List(new Field("item", new Utf8(), true)),
        true,
      ),
      new Field("imports", new List(new Field("item", new Utf8(), true)), true),
      new Field("exports", new List(new Field("item", new Utf8(), true)), true),
      new Field("role", new Utf8(), true),
      new Field("parent_symbol", new Utf8(), true),
      new Field("file_skeleton", new Utf8(), true),
    ]);
  }

  async ensureTable(): Promise<lancedb.Table> {
    const db = await this.getDb();
    try {
      const table = await db.openTable(TABLE_NAME);
      await this.validateSchema(table);
      return table;
    } catch (_err) {
      const schema = this.buildSchema();
      const table = await db.createTable(TABLE_NAME, [this.seedRow()], {
        schema,
      });
      await table.delete('id = "seed"');
      return table;
    }
  }

  async insertBatch(records: VectorRecord[]): Promise<void> {
    if (!records.length) return;
    const table = await this.ensureTable();

    const toBuffer = (val: unknown): Buffer => {
      if (Buffer.isBuffer(val)) return val;
      if (ArrayBuffer.isView(val) && (val as ArrayBufferView).buffer) {
        const view = val as ArrayBufferView;
        return Buffer.from(
          view.buffer,
          view.byteOffset ?? 0,
          view.byteLength ?? undefined,
        );
      }
      if (
        val &&
        typeof val === "object" &&
        "type" in (val as any) &&
        (val as any).type === "Buffer" &&
        Array.isArray((val as any).data)
      ) {
        return Buffer.from((val as any).data);
      }
      if (Array.isArray(val)) return Buffer.from(val);
      return Buffer.alloc(0);
    };

    const toNumberArray = (val: unknown): number[] => {
      if (Array.isArray(val)) return val.map((x) => Number(x) || 0);
      if (ArrayBuffer.isView(val) && (val as ArrayBufferView).buffer) {
        return Array.from(val as unknown as ArrayLike<number>);
      }
      if (
        val &&
        typeof val === "object" &&
        !("length" in (val as any)) &&
        Object.keys(val as any).length > 0
      ) {
        // Plain object with numeric keys (e.g., from IPC serialization)
        return Object.entries(val as Record<string, unknown>)
          .filter(([k]) => !Number.isNaN(Number(k)))
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([, v]) => Number(v) || 0);
      }
      return [];
    };

    const rows = records.map((rec) => {
      const vec = (() => {
        const arr = toNumberArray(rec.vector);
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
        display_text: rec.display_text || rec.content, // fallback
        start_line: rec.start_line,
        end_line: rec.end_line,
        chunk_index: rec.chunk_index ?? null,
        is_anchor: rec.is_anchor ?? false,
        context_prev: rec.context_prev ?? "",
        context_next: rec.context_next ?? "",
        chunk_type: rec.chunk_type ?? "",
        complexity:
          typeof rec.complexity === "number" ? rec.complexity : undefined,
        is_exported: rec.is_exported ?? false,
        vector: vec,
        colbert: toBuffer(rec.colbert),
        doc_token_ids: rec.doc_token_ids ? Array.from(rec.doc_token_ids) : [],
        defined_symbols: rec.defined_symbols ?? [],
        referenced_symbols: rec.referenced_symbols ?? [],
        imports: rec.imports ?? [],
        exports: rec.exports ?? [],
        role: rec.role ?? "",
        parent_symbol: rec.parent_symbol ?? "",
        file_skeleton: rec.file_skeleton ?? "",
      };
    });

    try {
      await table.add(rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("found field not in schema")) {
        const schema = await table.schema();
        const schemaFields = schema.fields.map((f) => f.name);
        throw new Error(
          `[vector-db] schema mismatch detected (fields: ${schemaFields.join(
            ", ",
          )}). Please run "osgrep index --reset" to rebuild the index.`,
        );
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

  async hasAnyRows(): Promise<boolean> {
    const table = await this.ensureTable();
    const rows = await table.query().select(["id"]).limit(1).toArray();
    return rows.length > 0;
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
    if (this.db) {
      if (this.db.close) await this.db.close();
    }
    this.db = null;
  }
}
