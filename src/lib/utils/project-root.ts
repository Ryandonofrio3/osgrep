import * as fs from "node:fs";
import * as path from "node:path";
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
  let dir = start;
  const stopAt = path.parse(dir).root;

  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }

    if (dir === start) {
      const osgrepDir = path.join(dir, ".osgrep");
      if (
        fs.existsSync(osgrepDir) &&
        path.resolve(dir) !== path.resolve(PATHS.globalRoot)
      ) {
        return dir;
      }
    }

    if (dir === stopAt) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export function ensureProjectPaths(startDir = process.cwd()): ProjectPaths {
  const root = findProjectRoot(startDir) ?? path.resolve(startDir);
  const osgrepDir = path.join(root, ".osgrep");
  const lancedbDir = path.join(osgrepDir, "lancedb");
  const cacheDir = path.join(osgrepDir, "cache");
  const lmdbPath = path.join(cacheDir, "meta.lmdb");
  const configPath = path.join(osgrepDir, "config.json");

  [osgrepDir, lancedbDir, cacheDir].forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
  });

  ensureGitignoreEntry(root);

  return { root, osgrepDir, lancedbDir, cacheDir, lmdbPath, configPath };
}

function ensureGitignoreEntry(root: string) {
  // Only add when inside a git repo.
  if (!fs.existsSync(path.join(root, ".git"))) return;

  const gitignorePath = path.join(root, ".gitignore");
  let contents = "";
  try {
    contents = fs.readFileSync(gitignorePath, "utf-8");
  } catch {
    // ignore missing file; will create below
  }

  const hasEntry = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(".osgrep");
  if (hasEntry) return;

  const needsNewline = contents.length > 0 && !contents.endsWith("\n");
  const prefix = needsNewline ? "\n" : "";
  fs.writeFileSync(gitignorePath, `${contents}${prefix}.osgrep\n`, {
    encoding: "utf-8",
  });
}
