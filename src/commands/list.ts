import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { gracefulExit } from "../lib/utils/exit";

const style = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function getDirectorySize(dirPath: string): number {
  let totalSize = 0;
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory()) {
        totalSize += getDirectorySize(itemPath);
      } else {
        totalSize += stats.size;
      }
    }
  } catch { }

  return totalSize;
}

export const list = new Command("list")
  .description("Show the current project's .osgrep contents")
  .action(async () => {
    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
    const paths = ensureProjectPaths(projectRoot);

    const entries = [
      { label: "LanceDB", dir: paths.lancedbDir },
      { label: "Cache", dir: paths.cacheDir },
    ];

    console.log(`\n${style.bold("Project")}: ${style.green(projectRoot)}`);
    console.log(`${style.dim("Data directory")}: ${paths.osgrepDir}\n`);

    for (const entry of entries) {
      if (!fs.existsSync(entry.dir)) {
        console.log(`${entry.label}: ${style.dim("not created yet")}`);
        continue;
      }
      const stats = fs.statSync(entry.dir);
      const size = getDirectorySize(entry.dir);
      console.log(
        `${entry.label}: ${style.green(formatSize(size))} ${style.dim(
          `(updated ${formatDate(stats.mtime)})`,
        )}`,
      );
    }

    await gracefulExit();
  });
