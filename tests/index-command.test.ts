import { describe, it, expect, vi, beforeEach } from "vitest";

const fakeGit = {
  isWorktree: vi.fn(() => false),
  getMainRepoRoot: vi.fn(() => null),
};

vi.mock("../src/lib/context", () => {
  return {
    createStore: vi.fn(async () => fakeStore),
    createFileSystem: vi.fn(() => fakeFileSystem),
    createGit: vi.fn(() => fakeGit),
  };
});

vi.mock("../src/lib/setup-helpers", () => ({
  ensureSetup: vi.fn(async () => { }),
}));

vi.mock("../src/lib/store-helpers", () => ({
  ensureStoreExists: vi.fn(async () => { }),
}));

vi.mock("../src/lib/store-resolver", () => ({
  getAutoStoreId: vi.fn(() => "auto-store"),
}));

vi.mock("../src/lib/sync-helpers", () => ({
  createIndexingSpinner: vi.fn(() => ({
    spinner: {
      text: "",
      succeed: vi.fn(),
      fail: vi.fn(),
    },
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
}));

vi.mock("../src/lib/exit", () => ({
  gracefulExit: vi.fn(async () => { }),
}));

const fakeFileSystem = {
  getFiles: () => [].values(),
  isIgnored: () => false,
  loadOsgrepignore: () => { },
};

const fakeStore = {
  retrieve: vi.fn(async () => ({})),
  create: vi.fn(async () => ({})),
  getInfo: vi.fn(async () => ({ counts: { pending: 0, in_progress: 0 } })),
  close: vi.fn(async () => { }),
};

import { index } from "../src/commands/index";
import { initialSync } from "../src/utils";
import { createIndexingSpinner } from "../src/lib/sync-helpers";
import { ensureSetup } from "../src/lib/setup-helpers";

describe("index command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs dry-run indexing without hitting store wait loop", async () => {
    await index.parseAsync(["--dry-run"], { from: "user" });

    expect(ensureSetup).toHaveBeenCalledOnce();
    expect(initialSync).toHaveBeenCalledOnce();
    expect(fakeStore.close).toHaveBeenCalledOnce();
    const spinner = (createIndexingSpinner as any).mock.results[0]
      .value.spinner;
    expect(spinner.succeed).toHaveBeenCalled();
  });
});
