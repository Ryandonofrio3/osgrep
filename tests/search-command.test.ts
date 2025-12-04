import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const spinner = {
  text: "",
  succeed: vi.fn(),
  fail: vi.fn(),
};

vi.mock("../src/lib/setup/setup-helpers", () => ({
  ensureSetup: vi.fn(async () => { }),
}));

vi.mock("../src/lib/utils/project-root", () => ({
  ensureProjectPaths: vi.fn(() => ({
    root: "/tmp/project",
    osgrepDir: "/tmp/project/.osgrep",
    lancedbDir: "/tmp/project/.osgrep/lancedb",
    cacheDir: "/tmp/project/.osgrep/cache",
    lmdbPath: "/tmp/project/.osgrep/cache/meta.lmdb",
    configPath: "/tmp/project/.osgrep/config.json",
  })),
  findProjectRoot: vi.fn(() => "/tmp/project"),
}));

vi.mock("../src/lib/index/sync-helpers", () => ({
  createIndexingSpinner: vi.fn(() => ({
    spinner,
    onProgress: vi.fn(),
  })),
  formatDryRunSummary: vi.fn(() => "dry-run-summary"),
}));

vi.mock("../src/lib/index/syncer", () => ({
  initialSync: vi.fn(async () => ({
    processed: 1,
    indexed: 1,
    total: 1,
    failedFiles: 0,
  })),
}));

vi.mock("../src/lib/utils/file-utils", () => ({
  formatDenseSnippet: vi.fn((t) => t),
}));

const mockSearcher = {
  search: vi.fn(async () => ({
    data: [
      {
        metadata: { path: "/tmp/project/src/file.ts" },
        score: 1,
        type: "text",
        text: "content",
        generated_metadata: { start_line: 0, num_lines: 1 },
      },
    ],
  })),
};

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(() => ({
    listPaths: vi.fn(async () => new Map()),
    hasAnyRows: vi.fn(async () => false),
    createFTSIndex: vi.fn(async () => { }),
    close: vi.fn(async () => { }),
  })),
}));

vi.mock("../src/lib/search/searcher", () => ({
  Searcher: vi.fn(() => mockSearcher),
}));

import { search } from "../src/commands/search";
import { initialSync } from "../src/lib/index/syncer";

describe("search command", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.clearAllMocks();
    spinner.text = "";
    (search as Command).exitOverride();
  });

  it("auto-syncs when store is empty and performs search", async () => {
    const tmpDir = originalCwd;
    await (search as Command).parseAsync(["query"], { from: "user" });

    expect(initialSync).toHaveBeenCalled();
    expect(mockSearcher.search).toHaveBeenCalledWith(
      "query",
      expect.any(Number),
      { rerank: true },
      undefined,
      "",
    );
    expect(spinner.succeed).toHaveBeenCalled();
  });
});
