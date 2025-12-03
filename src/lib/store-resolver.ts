import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { createGit } from "./context";

/**
 * Extracts owner-repo format from various git URL formats
 * Handles HTTPS, SSH, and SSH protocol URLs
 *
 * Examples:
 * - https://github.com/owner/repo.git → owner-repo
 * - git@github.com:owner/repo.git → owner-repo
 * - ssh://git@server/project/repo → project-repo
 *
 * @param url - Git remote URL
 * @returns Sanitized owner-repo string
 */
export function extractRepoInfoFromUrl(url: string): string {
  // Remove .git suffix if present
  const cleanUrl = url.replace(/\.git$/, "");

  // Split by both / and : to handle various URL formats
  const parts = cleanUrl.split(/[\/:]/);

  // Extract last two non-empty parts (owner and repo)
  const nonEmptyParts = parts.filter((p) => p.length > 0);

  if (nonEmptyParts.length >= 2) {
    const repo = nonEmptyParts[nonEmptyParts.length - 1];
    const owner = nonEmptyParts[nonEmptyParts.length - 2];
    if (repo && owner) {
      return `${owner}-${repo}`.toLowerCase();
    }
  }

  // Fallback to just the last part (repo name)
  return nonEmptyParts[nonEmptyParts.length - 1]?.toLowerCase() || "unknown-repo";
}

/**
 * Converts a name to a safe store ID format
 * Replaces non-alphanumeric characters (except hyphens) with hyphens
 * Converts to lowercase for consistency
 *
 * @param name - Raw name to sanitize
 * @returns Sanitized kebab-case store ID
 */
export function sanitizeStoreName(name: string): string {
  return name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

/**
 * Automatically determines a unique store ID based on the target directory
 * Uses git remote information when available, falls back to directory-based naming
 *
 * Priority:
 * 1. Git repo with remote → owner-repo format (e.g., facebook-react)
 * 2. Git repo without remote → dirname-hash format (e.g., utils-7f8a2b3c)
 * 3. Non-git directory → dirname-hash format
 *
 * @param targetDir - Directory to resolve (defaults to current working directory)
 * @returns Collision-resistant store ID
 */
export function getAutoStoreId(targetDir: string = process.cwd()): string {
  const git = createGit();
  const absolutePath = resolve(targetDir);

  // Try Git Remote first (collision-resistant via owner-repo)
  try {
    const root = git.getRepositoryRoot(absolutePath);
    if (root) {
      const remote = git.getRemoteUrl(root);
      if (remote) {
        return sanitizeStoreName(extractRepoInfoFromUrl(remote));
      }
    }
  } catch (e) {
    // Ignore git errors, fall through to directory-based naming
  }

  // Fallback: Directory name + path hash (collision-resistant)
  const folderName = basename(absolutePath);
  const pathHash = createHash("sha256")
    .update(absolutePath)
    .digest("hex")
    .substring(0, 8);

  return sanitizeStoreName(`${folderName}-${pathHash}`);
}

/**
 * Resolves the store ID with git worktree awareness
 *
 * If running from within a git worktree, returns the store ID for the
 * main repository instead of the worktree itself. This allows worktrees
 * to share the same index as the main repo.
 *
 * @param targetDir - Directory to resolve (defaults to current working directory)
 * @returns Store ID for the main repository (or the directory itself if not in a worktree)
 */
export function resolveStoreIdWithWorktree(
  targetDir: string = process.cwd(),
): string {
  const git = createGit();
  const absolutePath = resolve(targetDir);

  // If in a worktree, resolve against main repo instead
  if (git.isWorktree(absolutePath)) {
    const mainRoot = git.getMainRepoRoot(absolutePath);
    if (mainRoot) {
      return getAutoStoreId(mainRoot);
    }
  }

  return getAutoStoreId(absolutePath);
}

