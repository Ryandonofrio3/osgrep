import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";

/**
 * GitIgnore filter using the ignore package with enhanced pattern support
 */
export class GitIgnoreFilter {
  private ignoreInstance: ReturnType<typeof ignore>;

  constructor(gitignoreContent?: string) {
    this.ignoreInstance = ignore();
    if (gitignoreContent) {
      this.add(gitignoreContent);
    }
  }

  /**
   * Normalizes a path for gitignore pattern matching
   */
  private normalizePathForIgnore(filePath: string, root: string): string {
    const relativePath = path.relative(root, filePath);
    // Normalize path separators for cross-platform compatibility
    return relativePath.replace(/\\/g, "/");
  }

  /**
   * Checks if a file path should be ignored based on gitignore patterns
   * Handles both files and directories properly
   */
  isIgnored(filePath: string, root: string): boolean {
    const normalizedPath = this.normalizePathForIgnore(filePath, root);
    if (!normalizedPath) return false; // Root directory itself

    // Check if it's a directory by attempting to stat the path
    let isDirectory = false;
    try {
      const stat = fs.statSync(filePath);
      isDirectory = stat.isDirectory();
    } catch {
      // If we can't stat the file, assume it's not a directory
      isDirectory = false;
    }

    // The ignore package expects directories to end with "/"
    const pathToCheck = isDirectory ? `${normalizedPath}/` : normalizedPath;
    return this.ignoreInstance.ignores(pathToCheck);
  }

  /**
   * Adds gitignore patterns from a string
   * The ignore package automatically handles comments and empty lines
   */
  add(patterns: string): void {
    this.ignoreInstance.add(patterns);
  }

  /**
   * Clears all patterns
   */
  clear(): void {
    this.ignoreInstance = ignore();
  }
}

/**
 * Interface for git operations
 */
export interface Git {
  /**
   * Checks if a directory is a git repository
   */
  isGitRepository(dir: string): boolean;

  /**
   * Gets the content of .gitignore file in a git repository
   */
  getGitIgnoreContent(repoRoot: string): string | null;

  /**
   * Gets all files tracked by git (both tracked and untracked but not ignored)
   */
  getGitFiles(dirRoot: string): AsyncGenerator<string>;

  /**
   * Gets or creates a cached GitIgnoreFilter for a repository
   */
  getGitIgnoreFilter(repoRoot: string): GitIgnoreFilter;

  /**
   * Gets the repository root directory (absolute path)
   * Returns null if not in a git repository
   */
  getRepositoryRoot(dir: string): string | null;

  /**
   * Gets the remote URL for origin
   * Returns null if no remote is configured
   */
  getRemoteUrl(dir: string): string | null;

  /**
   * Gets the git common directory (shared .git folder)
   * In main repo: Returns the .git directory path
   * In worktree: Returns the main repo's .git directory path
   */
  getGitCommonDir(dir: string): string | null;

  /**
   * Checks if the directory is inside a git worktree (not the main repo)
   * Returns true if in a linked worktree, false if in main repo or not a git repo
   */
  isWorktree(dir: string): boolean;

  /**
   * Gets the main repository root from a worktree
   * Returns the main repo root path, or null if not in a worktree
   */
  getMainRepoRoot(dir: string): string | null;
}

/**
 * Node.js implementation of the Git interface using git CLI commands
 */
export class NodeGit implements Git {
  private gitRepoCache = new Map<string, boolean>();
  private gitIgnoreCache = new Map<
    string,
    { filter: GitIgnoreFilter; mtime: number }
  >();
  private gitRootCache = new Map<string, string | null>();
  private gitRemoteCache = new Map<string, string | null>();
  private gitCommonDirCache = new Map<string, string | null>();
  private gitDirCache = new Map<string, string | null>();

  isGitRepository(dir: string): boolean {
    const normalizedDir = path.resolve(dir);

    const cached = this.gitRepoCache.get(normalizedDir);
    if (cached !== undefined) {
      return cached;
    }

    let isGit = false;
    try {
      const result = spawnSync("git", ["rev-parse", "--git-dir"], {
        cwd: dir,
        encoding: "utf-8",
      });
      isGit = result.status === 0 && !result.error;
    } catch {
      isGit = false;
    }

    this.gitRepoCache.set(normalizedDir, isGit);
    return isGit;
  }

  /**
   * Gets gitignore content from a git repository
   */
  getGitIgnoreContent(repoRoot: string): string | null {
    try {
      const gitignorePath = path.join(repoRoot, ".gitignore");
      if (fs.existsSync(gitignorePath)) {
        return fs.readFileSync(gitignorePath, "utf-8");
      }
    } catch (error) {
      // Log error but don't fail - .gitignore is optional
      console.error(
        `Warning: Failed to read .gitignore in ${repoRoot}:`,
        error,
      );
    }
    return null;
  }

  /**
   * Gets files using git ls-files when in a git repository
   * Uses streaming to handle large repositories without buffering everything in memory
   */
  async *getGitFiles(dirRoot: string): AsyncGenerator<string> {
    const { spawn } = await import("node:child_process");

    const child = spawn("git", ["ls-files", "-z", "--others", "--exclude-standard", "--cached"], {
      cwd: dirRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stderr.on("data", (data) => {
      // Log stderr but don't fail immediately, git might just be noisy
      const msg = data.toString().trim();
      if (msg) console.error(`[git] stderr: ${msg}`);
    });

    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += chunk.toString();
      const parts = buffer.split("\u0000");
      // The last part might be incomplete, save it for next chunk
      buffer = parts.pop() || "";
      for (const file of parts) {
        if (file) yield path.join(dirRoot, file);
      }
    }

    if (buffer) {
      yield path.join(dirRoot, buffer);
    }

    // Wait for process to exit to ensure we catch any final errors
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.on("error", () => resolve()); // If spawn fails, we just finish
    });
  }

  /**
   * Gets or creates a cached GitIgnoreFilter for a repository
   * Includes cache invalidation based on .gitignore modification time
   */
  getGitIgnoreFilter(repoRoot: string): GitIgnoreFilter {
    const normalizedRoot = path.resolve(repoRoot);
    const gitignorePath = path.join(repoRoot, ".gitignore");

    // Get current mtime of .gitignore file
    let currentMtime = 0;
    try {
      const stat = fs.statSync(gitignorePath);
      currentMtime = stat.mtime.getTime();
    } catch {
      // If .gitignore doesn't exist, use 0 as mtime
    }

    const cached = this.gitIgnoreCache.get(normalizedRoot);
    if (!cached || cached.mtime !== currentMtime) {
      // Cache miss or stale cache
      const filter = new GitIgnoreFilter();
      const gitignoreContent = this.getGitIgnoreContent(repoRoot);
      if (gitignoreContent) {
        filter.add(gitignoreContent);
      }
      this.gitIgnoreCache.set(normalizedRoot, { filter, mtime: currentMtime });
      return filter;
    }

    return cached.filter;
  }

  /**
   * Gets the repository root directory (absolute path)
   * Returns null if not in a git repository
   */
  getRepositoryRoot(dir: string): string | null {
    const normalizedDir = path.resolve(dir);

    const cached = this.gitRootCache.get(normalizedDir);
    if (cached !== undefined) {
      return cached;
    }

    let root: string | null = null;
    try {
      const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: dir,
        encoding: "utf-8",
      });
      if (result.status === 0 && !result.error && result.stdout) {
        root = result.stdout.trim();
      }
    } catch {
      root = null;
    }

    this.gitRootCache.set(normalizedDir, root);
    return root;
  }

  /**
   * Gets the remote URL for origin
   * Returns null if no remote is configured
   */
  getRemoteUrl(dir: string): string | null {
    const normalizedDir = path.resolve(dir);

    const cached = this.gitRemoteCache.get(normalizedDir);
    if (cached !== undefined) {
      return cached;
    }

    let remote: string | null = null;
    try {
      const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
        cwd: dir,
        encoding: "utf-8",
      });
      if (result.status === 0 && !result.error && result.stdout) {
        remote = result.stdout.trim();
      }
    } catch {
      remote = null;
    }

    this.gitRemoteCache.set(normalizedDir, remote);
    return remote;
  }

  /**
   * Gets the git directory using `git rev-parse --git-dir`
   * Returns the path to the .git directory (or file in worktrees)
   */
  private getGitDir(dir: string): string | null {
    const normalizedDir = path.resolve(dir);

    const cached = this.gitDirCache.get(normalizedDir);
    if (cached !== undefined) {
      return cached;
    }

    let gitDir: string | null = null;
    try {
      const result = spawnSync("git", ["rev-parse", "--git-dir"], {
        cwd: dir,
        encoding: "utf-8",
      });
      if (result.status === 0 && !result.error && result.stdout) {
        const rawPath = result.stdout.trim();
        gitDir = path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(dir, rawPath);
      }
    } catch {
      gitDir = null;
    }

    this.gitDirCache.set(normalizedDir, gitDir);
    return gitDir;
  }

  /**
   * Gets the git common directory using `git rev-parse --git-common-dir`
   * In main repo: Returns the same as --git-dir
   * In worktree: Returns the main repo's .git directory
   */
  getGitCommonDir(dir: string): string | null {
    const normalizedDir = path.resolve(dir);

    const cached = this.gitCommonDirCache.get(normalizedDir);
    if (cached !== undefined) {
      return cached;
    }

    let commonDir: string | null = null;
    try {
      const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: dir,
        encoding: "utf-8",
      });
      if (result.status === 0 && !result.error && result.stdout) {
        const rawPath = result.stdout.trim();
        commonDir = path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(dir, rawPath);
      }
    } catch {
      commonDir = null;
    }

    this.gitCommonDirCache.set(normalizedDir, commonDir);
    return commonDir;
  }

  /**
   * Checks if directory is in a git worktree (not the main repository)
   * Detection: --git-common-dir != --git-dir means we're in a worktree
   */
  isWorktree(dir: string): boolean {
    const gitDir = this.getGitDir(dir);
    const commonDir = this.getGitCommonDir(dir);

    if (!gitDir || !commonDir) {
      return false;
    }

    return gitDir !== commonDir;
  }

  /**
   * Gets the main repository root from a worktree
   * The common dir points to main-repo/.git, so parent is main repo root
   */
  getMainRepoRoot(dir: string): string | null {
    if (!this.isWorktree(dir)) {
      return null;
    }

    const commonDir = this.getGitCommonDir(dir);
    if (!commonDir) {
      return null;
    }

    // commonDir is like /path/to/main-repo/.git
    // Parent directory is the main repo root
    return path.dirname(commonDir);
  }
}
