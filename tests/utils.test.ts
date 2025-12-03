import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FileSystem } from "../src/lib/file";
import type {
  FileMetadata,
  IndexFileOptions,
  PreparedChunk,
  SearchResponse,
  Store,
  StoreFile,
  StoreInfo,
  VectorRecord,
} from "../src/lib/store";
import { initialSync } from "../src/utils";

class MemoryMetaStore {
  private store = new Map<string, string>();
  loadCalls = 0;
  saveCalls = 0;

  async load(): Promise<void> {
    this.loadCalls += 1;
  }
  async save(): Promise<void> {
    this.saveCalls += 1;
  }
  get(filePath: string): string | undefined {
    return this.store.get(filePath);
  }
  set(filePath: string, hash: string) {
    this.store.set(filePath, hash);
  }
  delete(filePath: string) {
    this.store.delete(filePath);
  }
}

class FakeFileSystem implements FileSystem {
  constructor(
    private readonly files: string[],
    private readonly ignored: Set<string> = new Set(),
  ) {}

  *getFiles(_root: string): Generator<string> {
    for (const file of this.files) {
      yield file;
    }
  }

  isIgnored(filePath: string, _root: string): boolean {
    return this.ignored.has(filePath);
  }

  loadOsgrepignore(): void {}
}

type StoredRecord = {
  content: string;
  metadata: FileMetadata;
  vector?: number[];
  colbert?: Buffer;
  colbert_scale?: number;
};

class FakeStore implements Store {
  records = new Map<string, StoredRecord>();
  indexCalls = 0;
  deleted: string[] = [];
  ftsIndexCreated = false;
  vectorIndexCreated = false;

  async *listFiles(): AsyncGenerator<StoreFile> {
    for (const [filePath, record] of this.records.entries()) {
      yield { external_id: filePath, metadata: record.metadata };
    }
  }

  async indexFile(
    _storeId: string,
    file: string | File | ReadableStream | NodeJS.ReadableStream,
    options: IndexFileOptions,
  ): Promise<PreparedChunk[]> {
    this.indexCalls += 1;
    const metadata = options.metadata || {
      path: options.external_id,
      hash: "",
    };
    const content =
      typeof file === "string"
        ? file
        : typeof options.content === "string"
          ? options.content
          : "";
    const chunk: PreparedChunk = {
      id: `${this.indexCalls}-${metadata.path}`,
      path: metadata.path,
      hash: metadata.hash,
      content,
      start_line: 0,
      end_line: 0,
      chunk_index: 0,
      is_anchor: false,
    };
    return [chunk];
  }

  async insertBatch(
    _storeId: string,
    records: VectorRecord[],
  ): Promise<void> {
    for (const record of records) {
      const key = record.path;
      this.records.set(key, {
        content: record.content,
        metadata: { path: record.path, hash: record.hash },
        vector: record.vector,
        colbert: record.colbert,
        colbert_scale: record.colbert_scale,
      });
    }
  }

  async search(
    _storeId: string,
    _query: string,
    _top_k?: number,
    _search_options?: { rerank?: boolean },
    _filters?: Record<string, unknown>,
  ): Promise<SearchResponse> {
    return { data: [] };
  }

  async retrieve(_storeId: string): Promise<unknown> {
    return {};
  }

  async create(): Promise<unknown> {
    return {};
  }

  async ask(
    _storeId: string,
    _question: string,
    _top_k?: number,
    _search_options?: { rerank?: boolean },
    _filters?: Record<string, unknown>,
  ) {
    return { answer: "", sources: [] };
  }

  async getInfo(): Promise<StoreInfo> {
    return {
      name: "test",
      description: "test",
      created_at: "",
      updated_at: "",
      counts: { pending: 0, in_progress: 0 },
    };
  }

  async createFTSIndex(): Promise<void> {
    this.ftsIndexCreated = true;
  }

  async createVectorIndex(): Promise<void> {
    this.vectorIndexCreated = true;
  }

  async deleteFile(_storeId: string, filePath: string): Promise<void> {
    this.records.delete(filePath);
    this.deleted.push(filePath);
  }

  async deleteFiles(_storeId: string, filePaths: string[]): Promise<void> {
    const unique = Array.from(new Set(filePaths));
    for (const filePath of unique) {
      await this.deleteFile(_storeId, filePath);
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

async function createTempRepo(
  files: Record<string, string>,
): Promise<{ root: string; filePaths: string[] }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osgrep-test-"));
  const filePaths: string[] = [];

  for (const [relative, content] of Object.entries(files)) {
    const filePath = path.join(root, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    filePaths.push(filePath);
  }

  return { root, filePaths };
}

describe("initialSync", () => {
  let store: FakeStore;
  let metaStore: MemoryMetaStore;

  beforeEach(() => {
    store = new FakeStore();
    metaStore = new MemoryMetaStore();
  });

  it("indexes new indexable files and skips non-indexable ones", async () => {
    const { root, filePaths } = await createTempRepo({
      "src/a.ts": "const a = 1;",
      "src/b.txt": "hello",
      "assets/logo.bin": "binarydata",
    });

    const fileSystem = new FakeFileSystem(filePaths);
    const result = await initialSync(
      store,
      fileSystem,
      "store",
      root,
      false,
      undefined,
      metaStore,
    );

    expect(result.total).toBe(1);
    expect(result.indexed).toBe(1);
    expect(store.records.has(path.join(root, "src/a.ts"))).toBe(true);
    expect(store.records.has(path.join(root, "src/b.txt"))).toBe(false);
    expect(store.records.has(path.join(root, "assets/logo.bin"))).toBe(false);
    expect(store.ftsIndexCreated).toBe(true);
    expect(store.vectorIndexCreated).toBe(true);
  });

  it("skips unchanged files when meta hashes match", async () => {
    const { root, filePaths } = await createTempRepo({
      "index.ts": "const first = 1;",
    });

    const fileSystem = new FakeFileSystem(filePaths);
    await initialSync(
      store,
      fileSystem,
      "store",
      root,
      false,
      undefined,
      metaStore,
    );
    const firstIndexCalls = store.indexCalls;

    const result = await initialSync(
      store,
      fileSystem,
      "store",
      root,
      false,
      undefined,
      metaStore,
    );

    expect(result.indexed).toBe(0);
    expect(store.indexCalls).toBe(firstIndexCalls);
    expect(store.ftsIndexCreated).toBe(true);
    expect(store.vectorIndexCreated).toBe(true);
  });

  it("skips zero-byte files from indexing", async () => {
    const { root, filePaths } = await createTempRepo({
      "empty.ts": "",
    });

    const fileSystem = new FakeFileSystem(filePaths);
    const result = await initialSync(
      store,
      fileSystem,
      "store",
      root,
      false,
      undefined,
      metaStore,
    );

    expect(result.indexed).toBe(0);
    expect(result.processed).toBe(0);
    expect(store.indexCalls).toBe(0);
  });

  it("does not persist meta or build indexes during dry run", async () => {
    const { root, filePaths } = await createTempRepo({
      "index.ts": "const value = 1;",
    });
    const fileSystem = new FakeFileSystem(filePaths);

    await initialSync(
      store,
      fileSystem,
      "store",
      root,
      true,
      undefined,
      metaStore,
    );

    expect(store.ftsIndexCreated).toBe(false);
    expect(store.vectorIndexCreated).toBe(false);
    expect(metaStore.saveCalls).toBe(0);
  });

  it("reindexes when file content changes", async () => {
    const { root, filePaths } = await createTempRepo({
      "index.ts": "const value = 1;",
    });
    const fileSystem = new FakeFileSystem(filePaths);

    await initialSync(
      store,
      fileSystem,
      "store",
      root,
      false,
      undefined,
      metaStore,
    );
    expect(store.indexCalls).toBe(1);

    await fs.writeFile(path.join(root, "index.ts"), "const value = 2;");

    const result = await initialSync(
      store,
      fileSystem,
      "store",
      root,
      false,
      undefined,
      metaStore,
    );

    expect(result.indexed).toBe(1);
    expect(store.indexCalls).toBe(2);
  });

  it("deletes stale store entries no longer on disk", async () => {
    const { root, filePaths } = await createTempRepo({
      "index.ts": "const liveFile = true;",
    });
    store.records.set(path.join(root, "missing.ts"), {
      content: "old",
      metadata: { path: path.join(root, "missing.ts"), hash: "old" },
    });

    const fileSystem = new FakeFileSystem(filePaths);
    const result = await initialSync(
      store,
      fileSystem,
      "store",
      root,
      false,
      undefined,
      metaStore,
    );

    expect(result.indexed).toBe(1);
    expect(store.deleted).toContain(path.join(root, "missing.ts"));
    expect(store.records.has(path.join(root, "missing.ts"))).toBe(false);
  });

  it("honors ignored files from the file system", async () => {
    const { root, filePaths } = await createTempRepo({
      "keep.ts": "const keep = true;",
      "ignore.ts": "const ignoreMe = true;",
    });

    const ignored = new Set<string>([path.join(root, "ignore.ts")]);
    const fileSystem = new FakeFileSystem(filePaths, ignored);

    const result = await initialSync(
      store,
      fileSystem,
      "store",
      root,
      false,
      undefined,
      metaStore,
    );

    expect(result.total).toBe(1);
    expect(store.records.has(path.join(root, "keep.ts"))).toBe(true);
    expect(store.records.has(path.join(root, "ignore.ts"))).toBe(false);
  });
});

describe("MetaStore persistence", () => {
  const originalHome = os.homedir();
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "osgrep-home-"));
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    vi.doUnmock("node:os");
    vi.resetModules();
    try {
      await fs.rm(tempHome, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("saves and reloads meta data to disk", async () => {
    vi.doMock("node:os", () => {
      const realOs = require("node:os") as typeof import("node:os");
      return { ...realOs, homedir: () => tempHome };
    });

    const { MetaStore } = await import("../src/utils");
    const meta = new MetaStore();
    await meta.load();
    meta.set("/tmp/file.ts", "hash1");
    await meta.save();

    const fresh = new MetaStore();
    await fresh.load();

    expect(fresh.get("/tmp/file.ts")).toBe("hash1");
  });

  it("handles missing meta file gracefully", async () => {
    vi.doMock("node:os", () => {
      const realOs = require("node:os") as typeof import("node:os");
      return { ...realOs, homedir: () => tempHome };
    });

    const { MetaStore } = await import("../src/utils");
    const meta = new MetaStore();
    await meta.load();

    expect(meta.get("/missing")).toBeUndefined();
  });
});
