import { join, normalize } from "node:path";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { createFileSystem, createStore } from "../lib/context";
import { ensureSetup } from "../lib/setup-helpers";
import type { FileMetadata, SearchResponse, Store } from "../lib/store";
import { DEFAULT_IGNORE_PATTERNS } from "../lib/ignore-patterns";
import { ensureStoreExists, isStoreEmpty } from "../lib/store-helpers";
import { resolveStoreIdWithWorktree } from "../lib/store-resolver";
import { createGit } from "../lib/context";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/sync-helpers";
import {
  initialSync,
  MetaStore,
  readServerLock,
} from "../utils";
import { formatTextResults, type TextResult } from "../lib/formatter";
import { gracefulExit } from "../lib/exit";



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
      store?: string;
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

    // Resolve root to main repo if in a worktree
    let root = process.cwd();
    const git = createGit();
    if (git.isWorktree(root)) {
      const mainRoot = git.getMainRepoRoot(root);
      if (mainRoot) {
        root = mainRoot;
      }
    }

    // Try server fast path for standard text search
    async function tryServerFastPath(): Promise<boolean> {
      const lock = await readServerLock(root);
      if (!lock || !lock.authToken) return false;

      const authHeader = { Authorization: `Bearer ${lock.authToken}` };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 100);
      try {
        const health = await fetch(`http://localhost:${lock.port}/health`, {
          signal: controller.signal,
          headers: authHeader,
        });
        if (!health.ok) return false;
      } catch (_err) {
        return false;
      } finally {
        clearTimeout(timeout);
      }

      try {
        const searchRes = await fetch(
          `http://localhost:${lock.port}/search`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...authHeader,
            },
            body: JSON.stringify({
              query: pattern,
              limit: parseInt(options.m, 10),
              rerank: true,
              path: exec_path ?? "",
            }),
          },
        );
        if (!searchRes.ok) return false;
        const payload = await searchRes.json();

        // Check for the status flag
        if (payload.status === "indexing") {
          const pct = payload.progress ?? 0;
          console.error(
            `⚠️  osgrep is currently indexing (${pct}% complete). Results may be partial.\n`,
          );
        }

        // Auto-detect plain mode if not in TTY (e.g. piped to agent)
        const isTTY = process.stdout.isTTY;
        const shouldBePlain = options.plain || !isTTY;

        // Rehydrate server results to match local store shape expected by formatTextResults.
        const rehydratedResults = (payload.results ?? []).map((r: any) => ({
          score: typeof r.score === "number" ? r.score : 0,
          text: r.content ?? r.snippet ?? "",
          metadata: {
            path: typeof r.path === "string" ? r.path : "Unknown path",
            is_anchor: r.is_anchor === true,
          },
          generated_metadata: {
            type: r.chunk_type,
            start_line: typeof r.start_line === "number" ? r.start_line : 0,
            num_lines:
              typeof r.num_lines === "number" ? r.num_lines : undefined,
          },
        }));

        const mappedResults: TextResult[] = toTextResults(
          rehydratedResults as SearchResponse["data"],
        );

        const output = formatTextResults(mappedResults, pattern, root, {
          isPlain: shouldBePlain,
          compact: options.compact,
          content: options.content,
        });
        console.log(output);
        return true;
      } catch (_err) {
        return false;
      }
    }

    const fast = await tryServerFastPath();
    if (fast) {
      return;
    }

    let store: Store | null = null;
    try {
      await ensureSetup();
      store = await createStore();

      // Auto-detect store ID if not explicitly provided
      // Uses worktree-aware resolution to share index with main repo
      const storeId = options.store || resolveStoreIdWithWorktree(root);

      await ensureStoreExists(store, storeId);
      const autoSync =
        options.sync || (await isStoreEmpty(store, storeId));
      let didSync = false;

      if (autoSync) {
        const fileSystem = createFileSystem({
          ignorePatterns: DEFAULT_IGNORE_PATTERNS,
        });
        const metaStore = new MetaStore();

        // Human/Agent mode
        const isTTY = process.stdout.isTTY;
        let abortController: AbortController | undefined;
        let signal: AbortSignal | undefined;

        // If non-interactive (Agent), enforce a timeout to prevent hanging
        if (!isTTY) {
          abortController = new AbortController();
          signal = abortController.signal;
          setTimeout(() => {
            abortController?.abort();
          }, 10000); // 10s timeout
        }

        // Show spinner and progress
        const { spinner, onProgress } = createIndexingSpinner(
          root,
          options.sync ? "Indexing..." : "Indexing repository (first run)...",
        );

        try {
          const result = await initialSync(
            store,
            fileSystem,
            storeId,
            root,
            options.dryRun,
            onProgress,
            metaStore,
            signal,
          );

          if (signal?.aborted) {
            spinner.warn(
              `Indexing timed out (${result.processed}/${result.total}). Results may be partial.`,
            );
          } else {
            while (true) {
              const info = await store.getInfo(storeId);
              spinner.text = `Indexing ${info.counts.pending + info.counts.in_progress} file(s)`;
              if (
                info.counts.pending === 0 &&
                info.counts.in_progress === 0
              ) {
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            spinner.succeed(
              `Indexing complete (${result.processed}/${result.total}) • indexed ${result.indexed}`,
            );
          }
          didSync = true;

          if (options.dryRun) {
            console.log(
              formatDryRunSummary(result, {
                actionDescription: "would have indexed",
              }),
            );
            await gracefulExit();
          }
        } catch (err) {
          spinner.fail("Indexing failed");
          throw err;
        }
      }

      const search_path = exec_path?.startsWith("/")
        ? exec_path
        : normalize(join(root, exec_path ?? ""));

      // Execute Search
      const results = await store.search(
        storeId,
        pattern,
        parseInt(options.m, 10),
        { rerank: true },
        {
          all: [
            {
              key: "path",
              operator: "starts_with",
              value: search_path,
            },
          ],
        },
      );

      // Hint if no results found
      if (results.data.length === 0) {
        if (!didSync) {
          try {
            const info = await store.getInfo(storeId);
            if (info.counts.pending === 0 && info.counts.in_progress === 0) {
              // Store exists but no results - might need re-indexing if files changed
              console.log(
                "No results found. If files have changed, you can re-index with 'osgrep index' or 'osgrep search --sync \"<query>\"'.\n",
              );
            }
          } catch {
            console.log(
              "No results found. The repository will be automatically indexed on your next search.\n",
            );
          }
        }
        await gracefulExit();
        return;
      }

      // Auto-detect plain mode if not in TTY (e.g. piped to agent)
      const isTTY = process.stdout.isTTY;
      const shouldBePlain = options.plain || !isTTY;

      // Render Output
      const mappedResults: TextResult[] = toTextResults(results.data);
      const output = formatTextResults(mappedResults, pattern, root, {
        isPlain: shouldBePlain,
        compact: options.compact,
        content: options.content,
      });

      console.log(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to search:", message);
      process.exitCode = 1;
      await gracefulExit(1);
    } finally {
      // Always clean up the store
      if (store && typeof store.close === "function") {
        try {
          await store.close();
        } catch (err) {
          console.error("Failed to close store:", err);
        }
      }
    }
    await gracefulExit();
  });
