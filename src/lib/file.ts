import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import type { Git } from "./git";

/**
 * Configuration options for file system operations
 */
export interface FileSystemOptions {
  /**
   * Additional glob patterns to ignore (in addition to .gitignore and hidden files)
   */
  ignorePatterns: string[];
}

/**
 * Interface for file system operations
 */
export interface FileSystem {
  /**
   * Gets all files in a directory
   */
  getFiles(dirRoot: string): Generator<string>;

  /**
   * Checks if a file should be ignored
   */
  isIgnored(filePath: string, root: string): boolean;

  /**
   * Loads the osgrepignore file for a directory
   */
  loadOsgrepignore(dirRoot: string): void;
}

/**
 * Node.js implementation of FileSystem with gitignore support
 */
export class NodeFileSystem implements FileSystem {
  private customIgnoreFilter: ReturnType<typeof ignore>;

  constructor(
    private git: Git,
    options: FileSystemOptions,
  ) {
    this.customIgnoreFilter = ignore();
    this.customIgnoreFilter.add(options.ignorePatterns);
  }

  /**
   * Checks if a file is a hidden file (starts with .)
   */
  private isHiddenFile(filePath: string, root: string): boolean {
    const relativePath = path.relative(root, filePath);
    const parts = relativePath.split(path.sep);
    return parts.some(
      (part) => part.startsWith(".") && part !== "." && part !== "..",
    );
  }

  /**
   * Gets all files recursively from a directory
   */
  private *getAllFilesRecursive(dir: string, root: string): Generator<string> {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (this.isHiddenFile(fullPath, root)) {
          continue;
        }

        if (entry.isDirectory()) {
          yield* this.getAllFilesRecursive(fullPath, root);
        } else if (entry.isFile()) {
          yield fullPath;
        }
      }
    } catch (error) {
      // Log permission or other filesystem errors
      console.error(`Warning: Failed to read directory ${dir}:`, error);
    }
  }

  *getFiles(dirRoot: string): Generator<string> {
    this.loadOsgrepignore(dirRoot);
    if (this.git.isGitRepository(dirRoot)) {
      let yielded = false;
      for (const file of this.git.getGitFiles(dirRoot)) {
        yielded = true;
        yield file;
      }

      // git can fail silently on very large repos; fall back to filesystem traversal
      if (!yielded) {
        console.warn(
          `git ls-files returned no results for ${dirRoot}. Falling back to filesystem traversal...`,
        );
        yield* this.getAllFilesRecursive(dirRoot, dirRoot);
      }

      return;
    }

    yield* this.getAllFilesRecursive(dirRoot, dirRoot);
  }

  isIgnored(filePath: string, root: string): boolean {
    // Always ignore hidden files
    if (this.isHiddenFile(filePath, root)) {
      return true;
    }

    // Check custom ignore patterns
    const relativePath = path.relative(root, filePath);
    const normalizedPath = relativePath.replace(/\\/g, "/");

    // Check if it's a directory
    let isDirectory = false;
    try {
      const stat = fs.statSync(filePath);
      isDirectory = stat.isDirectory();
    } catch {
      isDirectory = false;
    }

    const pathToCheck = isDirectory ? `${normalizedPath}/` : normalizedPath;
    if (this.customIgnoreFilter.ignores(pathToCheck)) {
      return true;
    }

    // If in a git repository, check gitignore patterns
    if (this.git.isGitRepository(root)) {
      const filter = this.git.getGitIgnoreFilter(root);
      return filter.isIgnored(filePath, root);
    }

    return false;
  }

  loadOsgrepignore(dirRoot: string): void {
    const ignoreFile = path.join(dirRoot, ".osgrepignore");
    if (fs.existsSync(ignoreFile)) {
      this.customIgnoreFilter.add(fs.readFileSync(ignoreFile, "utf8"));
    }
  }
}
