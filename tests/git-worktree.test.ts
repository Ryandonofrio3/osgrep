import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGitCommonDir, getMainRepoRoot, isWorktree } from "../src/lib/utils/git";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function makeWorktreeFixture() {
  const root = makeTempDir("osgrep-worktree-fixture-");
  const mainRepoRoot = path.join(root, "Documents", "GitHub", "repo");
  const worktreeRoot = path.join(
    root,
    "conductor",
    "workspaces",
    "repo",
    "feature-branch",
  );
  const mainGitDir = path.join(mainRepoRoot, ".git");
  const worktreeGitDir = path.join(mainGitDir, "worktrees", "feature-branch");

  fs.mkdirSync(mainGitDir, { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  writeFile(path.join(worktreeGitDir, "commondir"), "../..");

  return { root, mainRepoRoot, mainGitDir, worktreeRoot, worktreeGitDir };
}

describe("git worktree detection", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat a normal repo root as a worktree", () => {
    const { root, mainRepoRoot } = makeWorktreeFixture();
    created.push(root);

    expect(isWorktree(mainRepoRoot)).toBe(false);
    expect(getGitCommonDir(mainRepoRoot)).toBeNull();
    expect(getMainRepoRoot(mainRepoRoot)).toBeNull();
  });

  it("detects a worktree via gitfile even when outside the main repo tree", () => {
    const { root, mainRepoRoot, mainGitDir, worktreeRoot, worktreeGitDir } =
      makeWorktreeFixture();
    created.push(root);

    writeFile(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`);
    const expectedMainGitDir = fs.realpathSync.native(mainGitDir);
    const expectedMainRepoRoot = fs.realpathSync.native(mainRepoRoot);

    expect(isWorktree(worktreeRoot)).toBe(true);
    expect(getGitCommonDir(worktreeRoot)).toBe(expectedMainGitDir);
    expect(getMainRepoRoot(worktreeRoot)).toBe(expectedMainRepoRoot);
  });

  if (process.platform === "win32") {
    it.skip("detects a worktree when `.git` is a symlinked directory", () => {});
  } else {
    it("detects a worktree when `.git` is a symlinked directory", () => {
      const { root, mainRepoRoot, mainGitDir, worktreeRoot, worktreeGitDir } =
        makeWorktreeFixture();
      created.push(root);

      fs.symlinkSync(worktreeGitDir, path.join(worktreeRoot, ".git"));
      const expectedMainGitDir = fs.realpathSync.native(mainGitDir);
      const expectedMainRepoRoot = fs.realpathSync.native(mainRepoRoot);

      expect(isWorktree(worktreeRoot)).toBe(true);
      expect(getGitCommonDir(worktreeRoot)).toBe(expectedMainGitDir);
      expect(getMainRepoRoot(worktreeRoot)).toBe(expectedMainRepoRoot);
    });
  }
});
