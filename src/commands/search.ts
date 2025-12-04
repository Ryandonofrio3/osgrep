import * as path from "node:path";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { ensureSetup } from "../lib/setup/setup-helpers";
import type { FileMetadata, SearchResponse } from "../lib/store/types";
import { createIndexingSpinner, formatDryRunSummary } from "../lib/index/sync-helpers";
import { formatTextResults, type TextResult } from "../lib/utils/formatter";
import { initialSync } from "../lib/index/syncer";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { VectorDB } from "../lib/store/vector-db";
import { Searcher } from "../lib/search/searcher";
import { ensureGrammars } from "../lib/index/grammar-loader";
import { gracefulExit } from "../lib/utils/exit";

function toTextResults(data: SearchResponse["data"]): TextResult[] {
  return data.map((r) => {
    const rawPath =
      typeof (r.metadata as FileMetadata | undefined)?.path === "string"
        ? ((r.metadata as FileMetadata).path as string)
        : "Unknown path";

    return {
      path: rawPath,
      score: r.score,
      content: r.text || "",
      chunk_type: r.generated_metadata?.type,
      start_line: r.generated_metadata?.start_line ?? 0,
      end_line:
        (r.generated_metadata?.start_line ?? 0) +
        (r.generated_metadata?.num_lines ?? 0),
    };
  });
}

export const search: Command = new CommanderCommand("search")
  .description("File pattern searcher")
  .option(
    "-m <max_count>, --max-count <max_count>",
    "The maximum number of results to return (total)",
    "10",
  )
  .option("-c, --content", "Show full chunk content instead of snippets", false)
  .option(
    "--per-file <n>",
    "Number of matches to show per file",
    "1",
  )
  .option("--scores", "Show relevance scores", false)
  .option("--compact", "Show file paths only", false)
  .option("--plain", "Disable ANSI colors and use simpler formatting", false)
  .option(
    "-s, --sync",
    "Syncs the local files to the store before searching",
    false,
  )
  .option(
    "-d, --dry-run",
    "Dry run the search process (no actual file syncing)",
    false,
  )
  .argument("<pattern>", "The pattern to search for")
  .argument("[path]", "The path to search in")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (pattern, exec_path, _options, cmd) => {
    const options: {
      m: string;
      content: boolean;
      perFile: string;
      scores: boolean;
      compact: boolean;
      plain: boolean;
      sync: boolean;
      dryRun: boolean;
    } = cmd.optsWithGlobals();

    if (exec_path?.startsWith("--")) {
      exec_path = "";
    }

    const root = process.cwd();
    let vectorDb: VectorDB | null = null;

    try {
      await ensureSetup();
      const searchRoot = exec_path
        ? path.resolve(exec_path)
        : root;
      const projectRoot = findProjectRoot(searchRoot) ?? searchRoot;
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);
      const searcher = new Searcher(vectorDb);

      const hasRows = await vectorDb.hasAnyRows();
      const needsSync = options.sync || !hasRows;
      let didSync = false;

      if (needsSync) {
        const isTTY = process.stdout.isTTY;
        let abortController: AbortController | undefined;
        let signal: AbortSignal | undefined;

        if (!isTTY) {
          abortController = new AbortController();
          signal = abortController.signal;
          setTimeout(() => {
            abortController?.abort();
          }, 10000);
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
          const failedSuffix = result.failedFiles > 0 ? ` • ${result.failedFiles} failed` : "";
          spinner.succeed(
            `${options.sync ? "Indexing" : "Initial indexing"} complete (${result.processed}/${result.total}) • indexed ${result.indexed}${failedSuffix}`,
          );
          didSync = true;
        } catch (e) {
          spinner.fail("Indexing failed");
          throw e;
        }
      }

      const searchResult = await searcher.search(
        pattern,
        parseInt(options.m, 10),
        { rerank: true },
        undefined,
        exec_path ? path.relative(projectRoot, path.resolve(exec_path)) : "",
      );

      if (!searchResult.data.length) {
        console.log("No matches found.");
        return;
      }

      const isTTY = process.stdout.isTTY;
      const shouldBePlain = options.plain || !isTTY;

      const mappedResults = toTextResults(searchResult.data);

      const output = formatTextResults(mappedResults, pattern, projectRoot, {
        isPlain: shouldBePlain,
        compact: options.compact,
        content: options.content,
      });

      console.log(output);

      if (!didSync && !options.sync && !options.dryRun) {
        console.log("\nHint: Use --sync to ensure results are up-to-date.");
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
