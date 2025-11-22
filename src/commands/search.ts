import { extname, join, normalize } from "node:path";
import { highlight } from "cli-highlight";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { createFileSystem, createStore } from "../lib/context";
import { ensureSetup } from "../lib/setup-helpers";
import type { ChunkType, FileMetadata, SearchResponse } from "../lib/store";
import { ensureStoreExists, isStoreEmpty } from "../lib/store-helpers";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/sync-helpers";
import { initialSync, MetaStore } from "../utils";

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".py":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    case ".json":
      return "json";
    case ".md":
      return "markdown";
    case ".yml":
    case ".yaml":
      return "yaml";
    default:
      return "plaintext";
  }
}

function formatSearchResponse(response: SearchResponse, show_content: boolean) {
  return response.data
    .map((chunk) => formatChunk(chunk, show_content))
    .join("\n");
}

function formatChunk(chunk: ChunkType, show_content: boolean) {
  const pwd = process.cwd();
  const filePath = (chunk.metadata as FileMetadata)?.path || "";
  const path = filePath.replace(pwd, "") || "Unknown path";
  let line_range = "";
  let content = "";
  switch (chunk.type) {
    case "text": {
      const start_line = (chunk.generated_metadata?.start_line as number) + 1;
      const end_line =
        start_line + (chunk.generated_metadata?.num_lines as number);
      line_range = `:${start_line}-${end_line}`;
      content = show_content ? (chunk.text ?? "") : "";
      if (show_content && content) {
        const lang = detectLanguage(filePath);
        try {
          content = highlight(content, {
            language: lang,
            ignoreIllegals: true,
          });
        } catch (_err) {
          content = chunk.text ?? "";
        }
      }
      break;
    }
    case "image_url":
      line_range =
        chunk.generated_metadata?.type === "pdf"
          ? `, page ${(chunk.chunk_index ?? 0) + 1}`
          : "";
      break;
    case "audio_url":
      line_range = "";
      break;
    case "video_url":
      line_range = "";
      break;
  }

  return `.${path}${line_range} (Relevance Score: ${chunk.score.toFixed(4)})${content ? `\n${content}` : ""}`;
}

export const search: Command = new CommanderCommand("search")
  .description("File pattern searcher")
  .option("-i", "Makes the search case-insensitive", false)
  .option("-r", "Recursive search", false)
  .option(
    "-m <max_count>, --max-count <max_count>",
    "The maximum number of results to return",
    "10",
  )
  .option("-c, --content", "Show content of the results", false)
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
      store: string;
      m: string;
      c: boolean;
      sync: boolean;
      dryRun: boolean;
    } = cmd.optsWithGlobals();
    if (exec_path?.startsWith("--")) {
      exec_path = "";
    }

    try {
      await ensureSetup({ silent: true });
      const store = await createStore();
      await ensureStoreExists(store, options.store);
      const root = process.cwd();
      const autoSync =
        options.sync || (await isStoreEmpty(store, options.store));
      let didSync = false;

      if (autoSync) {
        const fileSystem = createFileSystem({
          ignorePatterns: [
            "*.lock",
            "*.bin",
            "*.ipynb",
            "*.pyc",
            "pnpm-lock.yaml",
            "package-lock.json",
            "yarn.lock",
            "bun.lockb",
          ],
        });
        const metaStore = new MetaStore();
        const { spinner, onProgress } = createIndexingSpinner(
          root,
          options.sync ? "Indexing..." : "Indexing repository (first run)...",
        );
        const result = await initialSync(
          store,
          fileSystem,
          options.store,
          root,
          options.dryRun,
          onProgress,
          metaStore,
        );
        while (true) {
          const info = await store.getInfo(options.store);
          spinner.text = `Indexing ${info.counts.pending + info.counts.in_progress} file(s)`;
          if (info.counts.pending === 0 && info.counts.in_progress === 0) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        spinner.succeed(
          `Indexing complete (${result.processed}/${result.total}) • indexed ${result.indexed}`,
        );
        didSync = true;
        if (options.dryRun) {
          console.log(
            formatDryRunSummary(result, {
              actionDescription: "would have indexed",
            }),
          );
          process.exit(0);
        }
      }

      const search_path = exec_path?.startsWith("/")
        ? exec_path
        : normalize(join(root, exec_path ?? ""));

      const results = await store.search(
        options.store,
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

      // Hint if store is empty
      if (results.data.length === 0) {
        if (!didSync) {
          try {
            const info = await store.getInfo(options.store);
            if (info.counts.pending === 0 && info.counts.in_progress === 0) {
              console.log(
                "No results found. If this is your first search, run 'osgrep index' or 'osgrep --sync \"<query>\"' to index your repository first.\n",
              );
            }
          } catch {
            // Store doesn't exist yet
            console.log(
              "No index found. Run 'osgrep index' or 'osgrep --sync \"<query>\"' to index your repository first.\n",
            );
          }
        }
      }

      const response = formatSearchResponse(results, options.c);
      console.log(response);

      // Exit cleanly after successful search
      process.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to search:", message);
      process.exit(1);
    }
  });
