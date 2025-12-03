import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const spinner = {
  text: "",
  succeed: vi.fn(),
  fail: vi.fn(),
};

const mockStore = {
  search: vi.fn(async () => ({ data: [{ metadata: { path: "/repo/file.ts" }, score: 1, type: "text" }] })),
  getInfo: vi.fn(async () => ({ counts: { pending: 0, in_progress: 0 } })),
  close: vi.fn(async () => { }),
};

const mockFileSystem = {
  getFiles: () => [].values(),
  isIgnored: () => false,
  loadOsgrepignore: () => { },
};

const mockGit = {
  isWorktree: vi.fn(() => false),
  getMainRepoRoot: vi.fn(() => null),
};

vi.mock("../src/lib/context", () => ({
  createStore: vi.fn(async () => mockStore),
  createFileSystem: vi.fn(() => mockFileSystem),
  createGit: vi.fn(() => mockGit),
}));

vi.mock("../src/lib/setup-helpers", () => ({
  ensureSetup: vi.fn(async () => { }),
}));

vi.mock("../src/lib/store-helpers", () => ({
  ensureStoreExists: vi.fn(async () => { }),
  isStoreEmpty: vi.fn(async () => true),
}));

vi.mock("../src/lib/store-resolver", () => ({
  getAutoStoreId: vi.fn(() => "auto-store"),
  resolveStoreIdWithWorktree: vi.fn(() => "auto-store"),
}));

vi.mock("../src/lib/sync-helpers", () => ({
  createIndexingSpinner: vi.fn(() => ({
    spinner,
    onProgress: vi.fn(),
  })),
  formatDryRunSummary: vi.fn(() => "dry-run-summary"),
}));

vi.mock("../src/utils", () => ({
  MetaStore: class { },
  initialSync: vi.fn(async () => ({
    processed: 1,
    indexed: 1,
    total: 1,
  })),
  readServerLock: vi.fn(async () => null),
  formatDenseSnippet: vi.fn((t) => t),
}));

vi.mock("../src/lib/exit", () => ({
  gracefulExit: vi.fn(async () => { }),
}));

import { search } from "../src/commands/search";
import { initialSync } from "../src/utils";
import { isStoreEmpty } from "../src/lib/store-helpers";

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

    expect(isStoreEmpty).toHaveBeenCalled();
    expect(initialSync).toHaveBeenCalled();
    expect(mockStore.search).toHaveBeenCalledWith(
      "auto-store",
      "query",
      expect.any(Number),
      { rerank: true },
      {
        all: [
          {
            key: "path",
            operator: "starts_with",
            value: tmpDir,
          },
        ],
      },
    );
    expect(mockStore.close).toHaveBeenCalled();
    expect(spinner.succeed).toHaveBeenCalled();
  });
});
