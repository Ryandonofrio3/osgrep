import * as path from "node:path";
import { highlight } from "cli-highlight";
import { getLanguageByExtension } from "../store/languages";
import type { ChunkType, FileMetadata } from "../store/types";
import { style } from "../utils/ansi";

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath);
  const lang = getLanguageByExtension(ext);
  return lang?.id || "plaintext";
}

function formatScore(score?: number): string {
  if (typeof score !== "number") return "";
  const fixed = score.toFixed(3);
  return fixed
    .replace(/^0\./, ".")
    .replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m));
}

export function formatResult(
  result: ChunkType,
  root: string,
  options: { content?: boolean } = {},
): string {
  const metadata = result.metadata as FileMetadata;
  const relPath = path.relative(root, metadata.path);
  const line = result.generated_metadata?.start_line || 0;

  // Header: Role + File + Location
  const role = result.role || "IMPLEMENTATION";
  const roleColor =
    role === "DEFINITION"
      ? style.green
      : role === "ORCHESTRATION"
        ? style.cyan
        : style.blue;

  const header = `${roleColor(role)} ${style.gray(relPath)}:${line}`;

  // Breadcrumb
  const breadcrumb = result.context
    ?.filter((c: string) => !c.startsWith("File:"))
    .join(" > ");
  const breadcrumbLine = breadcrumb ? `\n${style.dim(breadcrumb)}` : "";

  // Context: What defines this, what it calls
  const context: string[] = [];
  if (
    Array.isArray(result.defined_symbols) &&
    result.defined_symbols.length > 0
  ) {
    context.push(`Defines: ${result.defined_symbols.join(", ")}`);
  }
  if (
    Array.isArray(result.referenced_symbols) &&
    result.referenced_symbols.length > 0
  ) {
    context.push(
      `Calls: ${result.referenced_symbols.slice(0, 3).join(", ")}${result.referenced_symbols.length > 3 ? "..." : ""}`,
    );
  }
  // Add score if available
  const scoreStr = formatScore(result.score);
  if (scoreStr) {
    context.push(`Score: ${scoreStr}`);
  }
  const contextLine =
    context.length > 0 ? `\n${style.gray(context.join(" | "))}` : "";

  // Code snippet
  let code = result.text || "";
  // Clean up noise
  code = code
    .split("\n")
    .filter((l) => !l.startsWith("// File:") && !l.startsWith("File:"))
    .join("\n")
    .trim();

  if (!options.content && code.split("\n").length > 15) {
    const lines = code.split("\n");
    code = [...lines.slice(0, 15), style.dim(`...`)].join("\n");
  }

  try {
    const lang = detectLanguage(metadata.path);
    code = highlight(code, { language: lang, ignoreIllegals: true });
  } catch {
    // ignore
  }

  return `
${header}${breadcrumbLine}${contextLine}

${code}

${style.dim("─".repeat(80))}
`.trim();
}

export function formatResults(
  results: ChunkType[],
  root: string,
  options: { content?: boolean } = {},
): string {
  if (results.length === 0) return "No results found.";
  return results.map((r) => formatResult(r, root, options)).join("\n\n");
}

