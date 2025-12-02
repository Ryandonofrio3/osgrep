import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NodeFileSystem } from "../src/lib/file";
import { GitIgnoreFilter } from "../src/lib/git";
import type { Git } from "../src/lib/git";

class FakeGit implements Git {
  constructor(private readonly isRepo = false) { }

  isGitRepository(): boolean {
    return this.isRepo;
  }
  getGitIgnoreContent(): string | null {
    return null;
  }
  async *getGitFiles(): AsyncGenerator<string> {
    yield* [];
  }
  getGitIgnoreFilter(): GitIgnoreFilter {
    return new GitIgnoreFilter();
  }
  getRepositoryRoot(): string | null {
    return null;
  }
  getRemoteUrl(): string | null {
    return null;
  }
}

describe("NodeFileSystem", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osgrep-fs-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("skips hidden files when traversing", async () => {
    const hiddenDir = path.join(tempRoot, ".hidden");
    await fs.mkdir(hiddenDir, { recursive: true });
    await fs.writeFile(path.join(hiddenDir, "secret.ts"), "secret");
    await fs.writeFile(path.join(tempRoot, "visible.ts"), "visible");

    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
    const files: string[] = [];
    for await (const file of fsImpl.getFiles(tempRoot)) {
      files.push(file);
    }

    expect(files.some((f) => f.includes(".hidden"))).toBe(false);
    expect(files.some((f) => f.endsWith("visible.ts"))).toBe(true);
  });

  it("applies .osgrepignore patterns", async () => {
    await fs.writeFile(path.join(tempRoot, "keep.ts"), "keep");
    await fs.writeFile(path.join(tempRoot, "skip.ts"), "skip");
    await fs.writeFile(path.join(tempRoot, ".osgrepignore"), "skip.ts\n");

    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
    // Trigger .osgrepignore loading
    for await (const _ of fsImpl.getFiles(tempRoot)) {
      // consume
    }
    expect(fsImpl.isIgnored(path.join(tempRoot, "skip.ts"), tempRoot)).toBe(
      true,
    );
    expect(fsImpl.isIgnored(path.join(tempRoot, "keep.ts"), tempRoot)).toBe(
      false,
    );
  });

  it("honors custom ignorePatterns option", async () => {
    await fs.writeFile(path.join(tempRoot, "keep.ts"), "keep");
    await fs.writeFile(path.join(tempRoot, "skip.log"), "skip");

    const fsImpl = new NodeFileSystem(new FakeGit(), {
      ignorePatterns: ["*.log"],
    });
    expect(fsImpl.isIgnored(path.join(tempRoot, "skip.log"), tempRoot)).toBe(
      true,
    );
    expect(fsImpl.isIgnored(path.join(tempRoot, "keep.ts"), tempRoot)).toBe(
      false,
    );
  });

  it("treats the repository root as not ignored without throwing", async () => {
    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });

    expect(() => fsImpl.isIgnored(tempRoot, tempRoot)).not.toThrow();
    expect(fsImpl.isIgnored(tempRoot, tempRoot)).toBe(false);
  });

  it("handles dot and parent paths without throwing or false positives", async () => {
    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
    const dotPath = path.join(tempRoot, ".");
    const parentPath = path.join(tempRoot, "..");

    expect(() => fsImpl.isIgnored(dotPath, tempRoot)).not.toThrow();
    expect(fsImpl.isIgnored(dotPath, tempRoot)).toBe(false);

    // Parent of root should still resolve safely and be treated as ignored to avoid indexing outside root
    expect(() => fsImpl.isIgnored(parentPath, tempRoot)).not.toThrow();
    expect(fsImpl.isIgnored(parentPath, tempRoot)).toBe(true);
  });

  it("normalizes odd separators without crashing the ignore filter", async () => {
    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
    const weirdPath = path.join(tempRoot, "foo", ".", "bar");

    await fs.mkdir(path.dirname(weirdPath), { recursive: true });
    await fs.writeFile(weirdPath, "content");

    expect(() => fsImpl.isIgnored(weirdPath, tempRoot)).not.toThrow();
    expect(fsImpl.isIgnored(weirdPath, tempRoot)).toBe(false);
  });
});

describe("GitIgnoreFilter", () => {
  it("ignores files and directories based on patterns", () => {
    const filter = new GitIgnoreFilter("dist/\n*.log\n");
    const root = fs.mkdtemp(path.join(os.tmpdir(), "osgrep-git-ignore-"));

    return root.then(async (temp) => {
      const distDir = path.join(temp, "dist");
      const appDir = path.join(temp, "app");
      await fs.mkdir(distDir, { recursive: true });
      await fs.mkdir(appDir, { recursive: true });
      await fs.writeFile(path.join(distDir, "file.js"), "content");
      await fs.writeFile(path.join(appDir, "debug.log"), "log");
      await fs.writeFile(path.join(appDir, "index.ts"), "ts");

      expect(filter.isIgnored(distDir, temp)).toBe(true);
      expect(filter.isIgnored(path.join(distDir, "file.js"), temp)).toBe(true);
      expect(filter.isIgnored(path.join(appDir, "debug.log"), temp)).toBe(true);
      expect(filter.isIgnored(path.join(appDir, "index.ts"), temp)).toBe(
        false,
      );

      await fs.rm(temp, { recursive: true, force: true });
    });
  });
});

describe("NodeFileSystem symlink handling", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osgrep-symlink-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("follows symlinks to files", async () => {
    await fs.writeFile(path.join(tempRoot, "real-file.txt"), "content");
    await fs.symlink(
      path.join(tempRoot, "real-file.txt"),
      path.join(tempRoot, "symlink-to-file.txt"),
    );

    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
    const files: string[] = [];
    for await (const file of fsImpl.getFiles(tempRoot)) {
      files.push(file);
    }

    expect(files).toContainEqual(path.join(tempRoot, "symlink-to-file.txt"));
    expect(files).toContainEqual(path.join(tempRoot, "real-file.txt"));
  });

  it("follows symlinks to directories and indexes their contents", async () => {
    await fs.mkdir(path.join(tempRoot, "real-dir"));
    await fs.writeFile(path.join(tempRoot, "real-dir", "file1.txt"), "content1");
    await fs.symlink(
      path.join(tempRoot, "real-dir"),
      path.join(tempRoot, "symlink-to-dir"),
    );

    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
    const files: string[] = [];
    for await (const file of fsImpl.getFiles(tempRoot)) {
      files.push(file);
    }

    // Files are indexed once per unique real directory (deduplication by real path).
    // The file should be found through either the symlink or real path (alphabetically first wins).
    const hasFile = files.some((f) => f.endsWith("file1.txt"));
    expect(hasFile).toBe(true);
    // Should only have one copy (not indexed twice through different paths)
    const file1Matches = files.filter((f) => f.endsWith("file1.txt"));
    expect(file1Matches.length).toBe(1);
  });

  it("skips broken symlinks without throwing", async () => {
    await fs.symlink(
      path.join(tempRoot, "nonexistent.txt"),
      path.join(tempRoot, "broken-symlink.txt"),
    );
    await fs.writeFile(path.join(tempRoot, "real-file.txt"), "content");

    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
    const files: string[] = [];

    // Should not throw
    for await (const file of fsImpl.getFiles(tempRoot)) {
      files.push(file);
    }

    expect(files).not.toContainEqual(path.join(tempRoot, "broken-symlink.txt"));
    expect(files).toContainEqual(path.join(tempRoot, "real-file.txt"));
  });

  it("handles circular symlinks without infinite loops", async () => {
    await fs.mkdir(path.join(tempRoot, "circular"));
    await fs.writeFile(
      path.join(tempRoot, "circular", "file.txt"),
      "content",
    );
    await fs.symlink(
      path.join(tempRoot, "circular"),
      path.join(tempRoot, "circular", "link-to-parent"),
    );

    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
    const files: string[] = [];

    // Should complete without hanging (timeout would fail the test)
    for await (const file of fsImpl.getFiles(tempRoot)) {
      files.push(file);
    }

    expect(files).toContainEqual(path.join(tempRoot, "circular", "file.txt"));
    // Should not have duplicates from following the circular link
    const circularFiles = files.filter((f) => f.includes("circular/file.txt"));
    expect(circularFiles.length).toBe(1);
  });
});

describe("NodeFileSystem symlink handling - monorepo scenario", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osgrep-monorepo-"));

    // Create monorepo structure:
    // model/
    //   index.ts
    // web/libs/model -> ../../model (symlink)
    // api/libs/model -> ../../model (symlink)

    await fs.mkdir(path.join(tempRoot, "model"));
    await fs.writeFile(
      path.join(tempRoot, "model", "index.ts"),
      "export const model = {}",
    );

    await fs.mkdir(path.join(tempRoot, "web", "libs"), { recursive: true });
    await fs.symlink(
      path.join(tempRoot, "model"),
      path.join(tempRoot, "web", "libs", "model"),
    );

    await fs.mkdir(path.join(tempRoot, "api", "libs"), { recursive: true });
    await fs.symlink(
      path.join(tempRoot, "model"),
      path.join(tempRoot, "api", "libs", "model"),
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("indexes files from shared model package (via symlinks or direct)", async () => {
    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
    const files: string[] = [];
    for await (const file of fsImpl.getFiles(tempRoot)) {
      files.push(file);
    }

    // The model content should be indexed exactly once (deduplication by real path).
    // It could be through any path: model/, web/libs/model/, or api/libs/model/
    const modelFiles = files.filter((f) => f.endsWith("index.ts"));
    expect(modelFiles.length).toBe(1);

    // Verify it was indexed through one of the valid paths
    const validPaths = [
      path.join(tempRoot, "model", "index.ts"),
      path.join(tempRoot, "web", "libs", "model", "index.ts"),
      path.join(tempRoot, "api", "libs", "model", "index.ts"),
    ];
    expect(validPaths).toContainEqual(modelFiles[0]);
  });

  it("symlinks allow access to content that would otherwise be inaccessible", async () => {
    // This test verifies the key benefit: if you only had symlinks (no direct path),
    // the content would still be indexed.
    const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osgrep-isolated-"));

    try {
      // Create a "hidden" directory that's only accessible via symlink
      const hiddenDir = await fs.mkdtemp(path.join(os.tmpdir(), "osgrep-hidden-"));
      await fs.writeFile(path.join(hiddenDir, "secret.ts"), "secret content");

      // Create a symlink to it from our workspace
      await fs.symlink(hiddenDir, path.join(isolatedRoot, "linked-content"));

      const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
      const files: string[] = [];
      for await (const file of fsImpl.getFiles(isolatedRoot)) {
        files.push(file);
      }

      // The symlinked content should be indexed
      expect(files).toContainEqual(path.join(isolatedRoot, "linked-content", "secret.ts"));

      await fs.rm(hiddenDir, { recursive: true, force: true });
    } finally {
      await fs.rm(isolatedRoot, { recursive: true, force: true });
    }
  });
});
