import * as fs from "node:fs";
import * as path from "node:path";
import { open, type RootDatabase } from "lmdb";
import { registerCleanup } from "../utils/cleanup";

export type MetaEntry = {
  hash: string;
  mtimeMs: number;
  size: number;
};

export class MetaCache {
  private db: RootDatabase<MetaEntry>;
  private unregisterCleanup?: () => void;
  private closed = false;

  constructor(lmdbPath: string) {
    fs.mkdirSync(path.dirname(lmdbPath), { recursive: true });
    this.db = open<MetaEntry>({
      path: lmdbPath,
      compression: true,
    });
    this.unregisterCleanup = registerCleanup(() => this.close());
  }

  get(filePath: string): MetaEntry | undefined {
    return this.db.get(filePath);
  }

  put(filePath: string, entry: MetaEntry): void {
    this.db.put(filePath, entry);
  }

  delete(filePath: string): void {
    this.db.remove(filePath);
  }

  async *entries(): AsyncGenerator<{ path: string; entry: MetaEntry }> {
    for await (const { key, value } of this.db.getRange()) {
      if (!value) continue;
      yield { path: String(key), entry: value };
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unregisterCleanup?.();
    this.unregisterCleanup = undefined;
    this.db.close();
  }
}
