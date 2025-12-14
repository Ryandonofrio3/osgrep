import * as fs from "node:fs";
import * as path from "node:path";

function realpathOrSelf(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

function parseGitdirFromGitfile(gitFilePath: string): string | null {
  try {
    const content = fs.readFileSync(gitFilePath, "utf-8").trim();
    if (!content.startsWith("gitdir: ")) return null;
    return content.slice(8).trim();
  } catch {
    return null;
  }
}

export function isWorktree(dir: string): boolean {
  const gitPath = path.join(dir, ".git");
  try {
    const stats = fs.statSync(gitPath);

    // Standard worktree: `.git` is a gitfile pointing at `.git/worktrees/<name>`.
    if (stats.isFile()) {
      const gitDir = parseGitdirFromGitfile(gitPath);
      if (!gitDir) return false;

      const absGitDir = realpathOrSelf(path.resolve(dir, gitDir));
      return fs.existsSync(path.join(absGitDir, "commondir"));
    }

    // Some tooling uses a symlinked directory for `.git` (e.g. external workspaces).
    // Worktree git dirs include a `commondir` file; main repo `.git` typically does not.
    if (stats.isDirectory()) {
      return fs.existsSync(path.join(gitPath, "commondir"));
    }

    return false;
  } catch {
    return false;
  }
}

export function getGitCommonDir(worktreeRoot: string): string | null {
  const gitPath = path.join(worktreeRoot, ".git");
  try {
    const stats = fs.statSync(gitPath);

    if (stats.isFile()) {
      const gitDir = parseGitdirFromGitfile(gitPath);
      if (!gitDir) return null;

      const absGitDir = realpathOrSelf(path.resolve(worktreeRoot, gitDir));

      const commonDirFile = path.join(absGitDir, "commondir");
      if (fs.existsSync(commonDirFile)) {
        const commonPath = fs.readFileSync(commonDirFile, "utf-8").trim();
        return realpathOrSelf(path.resolve(absGitDir, commonPath));
      }

      // Fallback: assume standard structure
      return realpathOrSelf(path.resolve(absGitDir, "../../"));
    }

    if (stats.isDirectory()) {
      const commonDirFile = path.join(gitPath, "commondir");
      if (!fs.existsSync(commonDirFile)) return null;

      const commonPath = fs.readFileSync(commonDirFile, "utf-8").trim();
      const resolvedGitDir = realpathOrSelf(gitPath);
      return realpathOrSelf(path.resolve(resolvedGitDir, commonPath));
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Resolves the main repository root from a worktree root.
 */
export function getMainRepoRoot(worktreeRoot: string): string | null {
  if (!isWorktree(worktreeRoot)) return null;

  const commonDir = getGitCommonDir(worktreeRoot);
  if (!commonDir) return null;

  // The common dir is usually .git inside the main repo root.
  // So the main repo root is the parent of commonDir.
  return path.dirname(commonDir);
}
