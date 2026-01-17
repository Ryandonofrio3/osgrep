import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { ensureGrammars } from "../lib/index/grammar-loader";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/index/sync-helpers";
import { initialSync } from "../lib/index/syncer";
import { Searcher } from "../lib/search/searcher";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { Skeletonizer } from "../lib/skeleton";
import { getStoredSkeleton } from "../lib/skeleton/retriever";
import type {
  ChunkType,
  FileMetadata,
  SearchResponse,
} from "../lib/store/types";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { formatTextResults, type TextResult } from "../lib/utils/formatter";
import { isLocked } from "../lib/utils/lock";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { getServerForProject } from "../lib/utils/server-registry";

function toTextResults(data: SearchResponse["data"]): TextResult[] {
  return data.map((r) => {
    const rawPath =
      typeof (r.metadata as FileMetadata | undefined)?.path === "string"
        ? ((r.metadata as FileMetadata).path as string)
        : "Unknown path";

    const start =
      typeof r.generated_metadata?.start_line === "number"
        ? r.generated_metadata.start_line
        : 0;
    const end =
      typeof r.generated_metadata?.end_line === "number"
        ? r.generated_metadata.end_line
        : start + Math.max(0, (r.generated_metadata?.num_lines ?? 1) - 1);

    return {
      path: rawPath,
      score: r.score,
      content: r.text || "",
      chunk_type: r.generated_metadata?.type,
      start_line: start,
      end_line: end,
    };
  });
}

type CompactHit = {
  path: string;
  range: string;
  start_line: number;
  end_line: number;
  role?: string;
  confidence?: string;
  score?: number;
  defined?: string[];
  preview?: string;
};

function getPreviewText(chunk: ChunkType): string {
  const maxLen = 140;
  const lines =
    chunk.text
      ?.split("\n")
      .map((l) => l.trim())
      .filter(Boolean) ?? [];
  let preview = lines[0] ?? "";

  if (!preview && chunk.defined_symbols?.length) {
    preview = chunk.defined_symbols[0] ?? "";
  }

  if (preview.length > maxLen) {
    preview = `${preview.slice(0, maxLen)}...`;
  }
  return preview;
}

function toCompactHits(data: SearchResponse["data"]): CompactHit[] {
  return data.map((chunk) => {
    const rawPath =
      typeof (chunk.metadata as FileMetadata | undefined)?.path === "string"
        ? ((chunk.metadata as FileMetadata).path as string)
        : "Unknown path";

    const start =
      typeof chunk.generated_metadata?.start_line === "number"
        ? chunk.generated_metadata.start_line
        : 0;
    const end =
      typeof chunk.generated_metadata?.end_line === "number"
        ? chunk.generated_metadata.end_line
        : start + Math.max(0, (chunk.generated_metadata?.num_lines ?? 1) - 1);

    return {
      path: rawPath,
      range: `${start + 1}-${end + 1}`,
      start_line: start,
      end_line: end,
      role: chunk.role,
      confidence: chunk.confidence,
      score: chunk.score,
      defined: Array.isArray(chunk.defined_symbols)
        ? chunk.defined_symbols.slice(0, 3)
        : typeof chunk.defined_symbols === "string"
          ? [chunk.defined_symbols]
          : typeof (chunk.defined_symbols as any)?.toArray === "function"
            ? ((chunk.defined_symbols as any).toArray() as string[]).slice(0, 3)
            : [],
      preview: getPreviewText(chunk),
    };
  });
}

function compactRole(role?: string): string {
  if (!role) return "UNK";
  if (role.startsWith("ORCH")) return "ORCH";
  if (role.startsWith("DEF")) return "DEF";
  if (role.startsWith("IMP")) return "IMPL";
  return role.slice(0, 4).toUpperCase();
}

function compactConf(conf?: string): string {
  if (!conf) return "U";
  const c = conf.toUpperCase();
  if (c.startsWith("H")) return "H";
  if (c.startsWith("M")) return "M";
  if (c.startsWith("L")) return "L";
  return "U";
}

function compactScore(score?: number): string {
  if (typeof score !== "number") return "";
  const fixed = score.toFixed(3);
  return fixed
    .replace(/^0\./, ".")
    .replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m));
}

function truncateEnd(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return `${s.slice(0, max - 3)}...`;
}

function padR(s: string, w: number) {
  const n = Math.max(0, w - s.length);
  return s + " ".repeat(n);
}
function padL(s: string, w: number) {
  const n = Math.max(0, w - s.length);
  return " ".repeat(n) + s;
}

function formatCompactTSV(
  hits: CompactHit[],
  projectRoot: string,
  query: string,
): string {
  if (!hits.length) return "No matches found.";
  const lines: string[] = [];
  lines.push(`osgrep hits\tquery=${query}\tcount=${hits.length}`);
  lines.push("path\tlines\tscore\trole\tconf\tdefined");

  for (const hit of hits) {
    const relPath = path.isAbsolute(hit.path)
      ? path.relative(projectRoot, hit.path)
      : hit.path;
    const score = compactScore(hit.score);
    const role = compactRole(hit.role);
    const conf = compactConf(hit.confidence);
    const defs = (hit.defined ?? []).join(",");
    lines.push([relPath, hit.range, score, role, conf, defs].join("\t"));
  }
  return lines.join("\n");
}

function formatCompactPretty(
  hits: CompactHit[],
  projectRoot: string,
  query: string,
  termWidth: number,
  useAnsi: boolean,
): string {
  if (!hits.length) return "No matches found.";

  const dim = (s: string) => (useAnsi ? `\x1b[90m${s}\x1b[0m` : s);
  const bold = (s: string) => (useAnsi ? `\x1b[1m${s}\x1b[0m` : s);

  const wLines = 9;
  const wScore = 6;
  const wRole = 4;
  const wConf = 1;
  const wDef = 20;

  const gutters = 5;
  const fixed = wLines + wScore + wRole + wConf + wDef + gutters;

  const wPath = Math.max(24, Math.min(64, termWidth - fixed));

  const header = `osgrep hits  count=${hits.length}  query="${query}"`;

  const cols = [
    padR("path", wPath),
    padR("lines", wLines),
    padL("score", wScore),
    padR("role", wRole),
    padR("c", wConf),
    padR("defined", wDef),
  ].join(" ");

  const out: string[] = [];
  out.push(bold(header));
  out.push(dim(cols));

  for (const hit of hits) {
    const relPath = path.isAbsolute(hit.path)
      ? path.relative(projectRoot, hit.path)
      : hit.path;
    const score = compactScore(hit.score);
    const role = compactRole(hit.role);
    const conf = compactConf(hit.confidence);
    const defs = (hit.defined ?? []).join(",") || "-";
    const displayPath = `${relPath}:${hit.start_line + 1}`;
    const paddedPath = padR(displayPath, wPath);

    const row = [
      paddedPath,
      padR(hit.range, wLines),
      padL(score || "", wScore),
      padR(role, wRole),
      padR(conf, wConf),
      padR(truncateEnd(defs, wDef), wDef),
    ].join(" ");

    out.push(row);
  }

  return out.join("\n");
}

function formatCompactTable(
  hits: CompactHit[],
  projectRoot: string,
  query: string,
  opts: { isTTY: boolean; plain: boolean },
): string {
  if (!hits.length) return "No matches found.";

  if (!opts.isTTY || opts.plain) {
    return formatCompactTSV(hits, projectRoot, query);
  }

  const termWidth = Math.max(80, process.stdout.columns ?? 120);
  return formatCompactPretty(hits, projectRoot, query, termWidth, true);
}

// Reuse Skeletonizer instance
let globalSkeletonizer: Skeletonizer | null = null;

async function outputSkeletons(
  results: any[],
  projectRoot: string,
  limit: number,
  db?: VectorDB | null,
): Promise<void> {
  const seenPaths = new Set<string>();
  const filesToProcess: string[] = [];

  for (const result of results) {
    const p = (result.metadata as any)?.path;
    if (typeof p === "string" && !seenPaths.has(p)) {
      seenPaths.add(p);
      filesToProcess.push(p);
      if (filesToProcess.length >= limit) break;
    }
  }

  if (filesToProcess.length === 0) {
    console.log("No skeleton matches found.");
    return;
  }

  // Reuse or init skeletonizer for fallbacks
  if (!globalSkeletonizer) {
    globalSkeletonizer = new Skeletonizer();
    // Lazy init only if we actually fallback
  }

  const skeletonOpts = { includeSummary: true };
  const skeletonResults: Array<{
    file: string;
    skeleton: string;
    tokens: number;
    error?: string;
  }> = [];

  for (const relPath of filesToProcess) {
    // 1. Try DB cache
    if (db) {
      const cached = await getStoredSkeleton(db, relPath);
      if (cached) {
        skeletonResults.push({
          file: relPath,
          skeleton: cached,
          tokens: Math.ceil(cached.length / 4), // Rough estimate
        });
        continue;
      }
    }

    // 2. Fallback to fresh generation
    await globalSkeletonizer.init();
    const absPath = path.resolve(projectRoot, relPath);
    if (!fs.existsSync(absPath)) {
      skeletonResults.push({
        file: relPath,
        skeleton: `// File not found: ${relPath}`,
        tokens: 0,
        error: "File not found",
      });
      continue;
    }

    const content = fs.readFileSync(absPath, "utf-8");
    const res = await globalSkeletonizer.skeletonizeFile(
      relPath,
      content,
      skeletonOpts,
    );
    skeletonResults.push({
      file: relPath,
      skeleton: res.skeleton,
      tokens: res.tokenEstimate,
      error: res.error,
    });
  }

  // Since search doesn't support --json explicitly yet, we just print text.
  // But if we ever add it, we have the structure.
  for (const res of skeletonResults) {
    console.log(res.skeleton);
    console.log(""); // Separator
  }
}

export const search: Command = new CommanderCommand("search")
  .description("File pattern searcher")
  .option(
    "-m <max_count>, --max-count <max_count>",
    "The maximum number of results to return (total)",
    "5",
  )
  .option("-c, --content", "Show full chunk content instead of snippets", false)
  .option("--per-file <n>", "Number of matches to show per file", "3")
  .option("--scores", "Show relevance scores", false)
  .option(
    "--min-score <score>",
    "Minimum relevance score (0-1) to include in results",
    "0",
  )
  .option(
    "--compact",
    "Compact hits view (paths + line ranges + role/preview)",
    false,
  )
  .option("--plain", "Disable ANSI colors and use simpler formatting", false)

  .option(
    "-s, --sync",
    "Syncs the local files to the store before searching",
    false,
  )
  .option(
    "-d, --dry-run",
    "Show what would be indexed without actually indexing",
    false,
  )
  .option(
    "--skeleton",
    "Show code skeleton for matching files instead of snippets",
    false,
  )
  .argument("<pattern>", "The pattern to search for")
  .argument("[path]", "The path to search in")
  .action(async (pattern, exec_path, _options, cmd) => {
    const options: {
      m: string;
      content: boolean;
      perFile: string;
      scores: boolean;
      minScore: string;
      compact: boolean;
      plain: boolean;
      sync: boolean;
      dryRun: boolean;
      skeleton: boolean;
    } = cmd.optsWithGlobals();

    const root = process.cwd();
    const minScore = Number.isFinite(Number.parseFloat(options.minScore))
      ? Number.parseFloat(options.minScore)
      : 0;
    let vectorDb: VectorDB | null = null;

    // Check for running server
    const execPathForServer = exec_path ? path.resolve(exec_path) : root;
    const projectRootForServer =
      findProjectRoot(execPathForServer) ?? execPathForServer;
    const server = getServerForProject(projectRootForServer);

    if (server) {
      try {
        const response = await fetch(`http://localhost:${server.port}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: pattern,
            limit: parseInt(options.m, 10),
            path: exec_path
              ? path.relative(projectRootForServer, path.resolve(exec_path))
              : undefined,
          }),
        });

        if (response.ok) {
          const body = (await response.json()) as { results: any[] };

          const searchResult = { data: body.results };
          const filteredData = searchResult.data.filter(
            (r) => typeof r.score !== "number" || r.score >= minScore,
          );

          if (options.skeleton) {
            await outputSkeletons(
              filteredData,
              projectRootForServer,
              parseInt(options.m, 10),
              // Server doesn't easily expose DB instance here in HTTP client mode,
              // but we are in client. Wait, this text implies "Server Search" block.
              // Client talks to server. The server returns JSON.
              // We don't have DB access here.
              // So we pass null, and it will fallback to generating local skeleton (if file exists locally).
              // This is acceptable for Phase 3.
              null,
            );
            return;
          }

          const compactHits = options.compact
            ? toCompactHits(filteredData)
            : [];

          if (options.compact) {
            const compactText = compactHits.length
              ? formatCompactTable(compactHits, projectRootForServer, pattern, {
                isTTY: !!process.stdout.isTTY,
                plain: !!options.plain,
              })
              : "No matches found.";
            console.log(compactText);
            return; // EXIT
          }

          if (!filteredData.length) {
            console.log("No matches found.");
            return; // EXIT
          }

          const isTTY = process.stdout.isTTY;
          const shouldBePlain = options.plain || !isTTY;

          if (shouldBePlain) {
            const mappedResults = toTextResults(filteredData);
            const output = formatTextResults(
              mappedResults,
              pattern,
              projectRootForServer,
              {
                isPlain: true,
                compact: options.compact,
                content: options.content,
                perFile: parseInt(options.perFile, 10),
                showScores: options.scores,
              },
            );
            console.log(output);
          } else {
            const { formatResults } = await import("../lib/output/formatter");
            const output = formatResults(filteredData, projectRootForServer, {
              content: options.content,
            });
            console.log(output);
          }

          return; // EXIT successful server search
        }
      } catch (e) {
        if (process.env.DEBUG) {
          console.error(
            "[search] server request failed, falling back to local:",
            e,
          );
        }
      }
    }

    try {
      await ensureSetup();
      const searchRoot = exec_path ? path.resolve(exec_path) : root;
      const projectRoot = findProjectRoot(searchRoot) ?? searchRoot;
      const paths = ensureProjectPaths(projectRoot);

      // Propagate project root to worker processes
      process.env.OSGREP_PROJECT_ROOT = projectRoot;

      vectorDb = new VectorDB(paths.lancedbDir);

      // Check for active indexing lock and warn if present
      // This allows agents (via shim) to know results might be partial.
      if (isLocked(paths.osgrepDir)) {
        console.warn(
          "⚠️  Warning: Indexing in progress... search results may be incomplete.",
        );
      }

      const hasRows = await vectorDb.hasAnyRows();
      const needsSync = options.sync || !hasRows;

      if (needsSync) {
        const isTTY = process.stdout.isTTY;
        let abortController: AbortController | undefined;
        let signal: AbortSignal | undefined;

        if (!isTTY) {
          abortController = new AbortController();
          signal = abortController.signal;
          setTimeout(() => {
            abortController?.abort();
          }, 60000); // 60 seconds timeout for non-TTY auto-indexing
        }

        const { spinner, onProgress } = createIndexingSpinner(
          projectRoot,
          options.sync ? "Indexing..." : "Indexing repository (first run)...",
        );

        try {
          await ensureGrammars(console.log, { silent: true });
          const result = await initialSync({
            projectRoot,
            dryRun: options.dryRun,
            onProgress,
            signal,
          });

          if (signal?.aborted) {
            spinner.warn(
              `Indexing timed out (${result.processed}/${result.total}). Results may be partial.`,
            );
          }

          if (options.dryRun) {
            spinner.succeed(
              `Dry run complete (${result.processed}/${result.total}) • would have indexed ${result.indexed}`,
            );
            console.log(
              formatDryRunSummary(result, {
                actionDescription: "would have indexed",
                includeTotal: true,
              }),
            );
            return;
          }

          await vectorDb.createFTSIndex();
          const failedSuffix =
            result.failedFiles > 0 ? ` • ${result.failedFiles} failed` : "";
          spinner.succeed(
            `${options.sync ? "Indexing" : "Initial indexing"} complete (${result.processed}/${result.total}) • indexed ${result.indexed}${failedSuffix}`,
          );
        } catch (e) {
          spinner.fail("Indexing failed");
          throw e;
        }
      }

      const searcher = new Searcher(vectorDb);

      const searchResult = await searcher.search(
        pattern,
        parseInt(options.m, 10),
        { rerank: true },
        undefined,
        exec_path ? path.relative(projectRoot, path.resolve(exec_path)) : "",
      );

      const filteredData = searchResult.data.filter(
        (r) => typeof r.score !== "number" || r.score >= minScore,
      );

      if (options.skeleton) {
        await outputSkeletons(
          filteredData,
          projectRoot,
          parseInt(options.m, 10),
          vectorDb,
        );
        return;
      }

      const compactHits = options.compact ? toCompactHits(filteredData) : [];
      const compactText =
        options.compact && compactHits.length
          ? formatCompactTable(compactHits, projectRoot, pattern, {
            isTTY: !!process.stdout.isTTY,
            plain: !!options.plain,
          })
          : options.compact
            ? "No matches found."
            : "";

      if (!filteredData.length) {
        console.log("No matches found.");
        return;
      }

      if (options.compact) {
        console.log(compactText);
        return;
      }

      const isTTY = process.stdout.isTTY;
      const shouldBePlain = options.plain || !isTTY;

      if (shouldBePlain) {
        const mappedResults = toTextResults(filteredData);
        const output = formatTextResults(mappedResults, pattern, projectRoot, {
          isPlain: true,
          compact: options.compact,
          content: options.content,
          perFile: parseInt(options.perFile, 10),
          showScores: options.scores,
        });
        console.log(output);
      } else {
        // Use new holographic formatter for TTY
        const { formatResults } = await import("../lib/output/formatter");
        const output = formatResults(filteredData, projectRoot, {
          content: options.content,
        });
        console.log(output);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Search failed:", message);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch (err) {
          console.error("Failed to close VectorDB:", err);
        }
      }
      await gracefulExit();
    }
  });
