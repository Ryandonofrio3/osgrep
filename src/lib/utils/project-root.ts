import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { PATHS } from "../../config";

export interface ProjectPaths {
  root: string;
  osgrepDir: string;
  lancedbDir: string;
  cacheDir: string;
  lmdbPath: string;
  configPath: string;
}

export function findProjectRoot(startDir = process.cwd()): string | null {
  const start = path.resolve(startDir);

  // Only consider the current directory; do not climb above the user's cwd.
  const osgrepDir = path.join(start, ".osgrep");
  const gitDir = path.join(start, ".git");
  if (
    (fs.existsSync(osgrepDir) || fs.existsSync(gitDir)) &&
    path.resolve(start) !== path.resolve(PATHS.globalRoot)
  ) {
    return start;
  }

  // Otherwise, treat the current dir as the root (per-subdirectory isolation).
  return start;
}

export function ensureProjectPaths(
  startDir = process.cwd(),
  options?: { dryRun?: boolean },
): ProjectPaths {
  const root = findProjectRoot(startDir) ?? path.resolve(startDir);
  const osgrepDir = path.join(root, ".osgrep");
  const lancedbDir = path.join(osgrepDir, "lancedb");
  const cacheDir = path.join(osgrepDir, "cache");
  const lmdbPath = path.join(cacheDir, "meta.lmdb");
  const configPath = path.join(osgrepDir, "config.json");

  if (!options?.dryRun) {
    [osgrepDir, lancedbDir, cacheDir].forEach((dir) => {
      fs.mkdirSync(dir, { recursive: true });
    });

    ensureGitignoreEntry(root);
  }

  return { root, osgrepDir, lancedbDir, cacheDir, lmdbPath, configPath };
}

function fileContainsEntry(filePath: string, entry: string): boolean {
  try {
    const contents = fs.readFileSync(filePath, "utf-8");
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .includes(entry);
  } catch {
    return false;
  }
}

function getGlobalExcludesPath(): string | null {
  let configuredPath: string | null = null;

  try {
    // Use --path flag so Git handles tilde expansion and ~user cases
    const result = execSync("git config --path --get core.excludesFile", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    if (result) {
      // Resolve relative paths against cwd
      configuredPath = path.isAbsolute(result) ? result : path.resolve(process.cwd(), result);
    }
  } catch {
    // Ignore errors (including timeout or no config set)
  }

  // If not explicitly configured, use Git's default location
  if (!configuredPath) {
    const configDir = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
    configuredPath = path.join(configDir, "git", "ignore");
  }

  return configuredPath;
}

function ensureGitignoreEntry(root: string) {
  // Only add when inside a git repo.
  if (!fs.existsSync(path.join(root, ".git"))) return;

  const entry = ".osgrep";

  // Check global excludes file first
  const globalExcludesPath = getGlobalExcludesPath();
  if (globalExcludesPath && fileContainsEntry(globalExcludesPath, entry)) return;

  // Check .git/info/exclude
  const excludePath = path.join(root, ".git", "info", "exclude");
  if (fileContainsEntry(excludePath, entry)) return;

  // Check .gitignore
  const gitignorePath = path.join(root, ".gitignore");
  if (fileContainsEntry(gitignorePath, entry)) return;

  // Add to .gitignore
  let contents = "";
  try {
    contents = fs.readFileSync(gitignorePath, "utf-8");
  } catch {
    // ignore missing file; will create below
  }

  const needsNewline = contents.length > 0 && !contents.endsWith("\n");
  const prefix = needsNewline ? "\n" : "";
  fs.writeFileSync(gitignorePath, `${contents}${prefix}${entry}\n`, {
    encoding: "utf-8",
  });
}
