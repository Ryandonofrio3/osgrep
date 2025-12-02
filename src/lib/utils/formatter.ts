import * as path from "node:path";
import { highlight } from "cli-highlight";

export interface TextResult {
  path: string;
  score: number;
  content: string;
  chunk_type?: string;
  start_line: number;
  end_line: number;
}

const style = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[39m`,
};

import { getLanguageByExtension } from "../core/languages";

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath);
  const lang = getLanguageByExtension(ext);
  return lang?.id || "plaintext";
}

function cleanSnippetLines(snippet: string): string[] {
  const NOISE_PREFIXES = [
    "File:",
    "Top comments:",
    "Preamble:",
    "(anchor)",
    "Imports:",
    "Exports:",
    "---",
  ];

  return snippet
    .split("\n")
    .map((line) => {
      let next = line.trimEnd();
      // Strip inline metadata that sometimes gets glued onto code lines
      const fileIdx = next.indexOf("File:");
      if (fileIdx !== -1) {
        next = next.slice(0, fileIdx).trimEnd();
      }
      return next;
    })
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return !NOISE_PREFIXES.some((p) => trimmed.startsWith(p));
    })
    .map((line) => {
      const limit = 140;
      if (line.length <= limit) return line;
      return `${line.slice(0, limit)}${style.dim(" ...")}`;
    });
}

/**
 * Formats search results for display (agent plain mode or human pretty mode).
 * Supports compact (paths only), score display, and content truncation options.
 */
export function formatTextResults(
  results: TextResult[],
  query: string,
  root: string,
  options: {
    isPlain: boolean;
    compact?: boolean;
    content?: boolean;
    perFile?: number;
    showScores?: boolean;
  },
): string {
  if (results.length === 0) return `osgrep: No results found for "${query}".`;

  // --- MODE: COMPACT (File paths only) ---
  if (options.compact) {
    const uniquePaths = Array.from(new Set(results.map((r) => r.path))).sort();
    return uniquePaths.map((p) => path.relative(root, p)).join("\n");
  }

  const fileGroups = new Map<string, TextResult[]>();
  results.forEach((r) => {
    const existing = fileGroups.get(r.path) || [];
    existing.push(r);
    fileGroups.set(r.path, existing);
  });
  const fileCount = fileGroups.size;

  // --- MODE A: AGENT (Hyper-Dense) ---
  // Goal: Max information density per token.
  // --- MODE A: AGENT (Hyper-Dense) ---
  // Goal: Max information density per token.
  if (options.isPlain) {
    let output = "";

    // Keep snippets compact but present so agents still see the code.
    const maxLines = 16;

    results.forEach((item) => {
      const relPath = path.relative(root, item.path);
      const line = Math.max(1, item.start_line + 1);

      // 1. Semantic Tags (The Agent's Guide)
      const tags: string[] = [];
      const type = item.chunk_type || "";
      if (type.match(/function|class|method/)) tags.push("Definition");
      const isTestPath =
        /(^|\/)(__tests__|tests?|specs?)(\/|$)/i.test(relPath) ||
        /\.(test|spec)\.[cm]?[jt]sx?$/i.test(relPath);
      if (isTestPath) tags.push("Test");
      const tagStr = tags.length > 0 ? ` [${tags.join(",")}]` : "";

      const lines = cleanSnippetLines(item.content);
      const truncated =
        !options.content && lines.length > maxLines
          ? [
            ...lines.slice(0, maxLines),
            `... (+${lines.length - maxLines} more lines)`,
          ]
          : lines;

      const scoreStr = options.showScores
        ? ` ${style.dim(`(score: ${item.score.toFixed(3)})`)}`
        : "";
      output += `${relPath}:${line}${scoreStr}${tagStr}\n`;
      truncated.forEach((ln) => {
        output += `  ${ln}\n`;
      });
      output += "\n";
    });
    output += `osgrep results (${results.length} matches across ${fileCount} files)`;
    return output.trim();
  }

  // --- MODE B: HUMAN (Pretty) ---
  // First pass: merge chunks and count actual displayed results
  const mergedGroups: Array<{ filePath: string; merged: TextResult[] }> = [];
  for (const [filePath, chunks] of fileGroups) {
    // 1. Sort by score descending (best matches first)
    chunks.sort((a, b) => b.score - a.score);

    // 2. Apply per-file limit
    const limit = options.perFile ?? 1000;
    const limitedChunks = chunks.slice(0, limit);

    // 3. Re-sort by line number for display
    limitedChunks.sort((a, b) => a.start_line - b.start_line);

    // Smart Stitching Logic
    const merged: TextResult[] = [];
    if (limitedChunks.length > 0) {
      let current = limitedChunks[0];
      for (let i = 1; i < limitedChunks.length; i++) {
        const next = limitedChunks[i];
        if (next.start_line <= current.end_line + 10) {
          current.content += `\n   // ...\n${next.content}`;
          current.end_line = next.end_line;
          if (next.chunk_type?.match(/function|class/))
            current.chunk_type = next.chunk_type;
        } else {
          merged.push(current);
          current = { ...next };
        }
      }
      merged.push(current);
    }
    mergedGroups.push({ filePath, merged });
  }

  const displayedCount = mergedGroups.reduce((sum, g) => sum + g.merged.length, 0);
  let output = `\n${style.bold(`osgrep results (query: "${query}", ${displayedCount} matches across ${fileCount} files)`)}\n`;
  let rank = 1;

  for (const { filePath, merged } of mergedGroups) {
    const relPath = path.relative(root, filePath);
    for (const item of merged) {
      const tags: string[] = [];
      if (item.chunk_type?.match(/function|class/)) tags.push("Definition");
      const tagStr =
        tags.length > 0 ? ` ${style.blue(`[${tags.join(", ")}]`)}` : "";

      const line = Math.max(1, item.start_line + 1);
      const snippet = item.content
        .trim()
        .replace(/^File:.*\n/, "")
        .replace(/^Function:.*\n/, "")
        .trim();

      const lines = cleanSnippetLines(snippet);
      const maxLines = 12;
      const truncated =
        !options.content && lines.length > maxLines
          ? [
            ...lines.slice(0, maxLines),
            style.dim(`... (+${lines.length - maxLines} more lines)`),
          ]
          : lines;

      // Apply syntax highlighting for humans
      let rendered = truncated.join("\n");
      try {
        const lang = detectLanguage(filePath);
        rendered = highlight(rendered, {
          language: lang,
          ignoreIllegals: true,
        });
      } catch {
        // fall back to non-highlighted text
      }

      const scoreStr = options.showScores
        ? ` ${style.dim(`(score: ${item.score.toFixed(3)})`)}`
        : "";

      output += `${rank}) 📂 ${style.green(relPath)}${style.dim(`:${line}`)}${tagStr}${scoreStr}\n`;
      const numbered = rendered.split("\n").map((ln, idx) => {
        const num = style.dim(`${line + idx}`.padStart(4));
        return `${num} │ ${ln}`;
      });
      numbered.forEach((ln) => {
        output += `${ln}\n`;
      });
      output += "\n";
      rank++;
    }
  }
  output += style.dim(`${displayedCount} matches across ${fileCount} files`);
  return output.trimEnd();
}
