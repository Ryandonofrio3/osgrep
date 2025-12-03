import { Command } from "commander";
import { createFileSystem, createStore } from "../lib/context";
import { DEFAULT_IGNORE_PATTERNS } from "../lib/ignore-patterns";
import { ensureSetup } from "../lib/setup-helpers";
import { ensureStoreExists } from "../lib/store-helpers";
import { getAutoStoreId } from "../lib/store-resolver";
import { createGit } from "../lib/context";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/sync-helpers";
import type { Store } from "../lib/store";
import { initialSync, MetaStore } from "../utils";

import { gracefulExit } from "../lib/exit";
import { ensureGrammars } from "../lib/grammar-loader";

const PROFILE_ENABLED =
  process.env.OSGREP_PROFILE === "1" || process.env.OSGREP_PROFILE === "true";

export const index = new Command("index")
  .description("Index the current directory and create searchable store")
  .option(
    "-d, --dry-run",
    "Dry run the indexing process (no actual file syncing)",
    false,
  )
  .option(
    "-p, --path <dir>",
    "Path to index (defaults to current directory)",
    "",
  )
  .option(
    "-r, --reset",
    "Remove existing index and re-index from scratch",
    false,
  )
  .action(async (_args, cmd) => {
    const options: { store?: string; dryRun: boolean; path: string; reset: boolean } =
      cmd.optsWithGlobals();

    let store: Store | null = null;
    try {
      await ensureSetup();
      store = await createStore();

      // Auto-detect store ID if not explicitly provided
      // If in a worktree, resolve to main repo so we index the shared codebase
      let indexRoot = options.path || process.cwd();
      const git = createGit();
      if (git.isWorktree(indexRoot)) {
        const mainRoot = git.getMainRepoRoot(indexRoot);
        if (mainRoot) {
          console.log(`Detected git worktree. Indexing main repository at: ${mainRoot}`);
          indexRoot = mainRoot;
        }
      }
      const storeId = options.store || getAutoStoreId(indexRoot);

      // Handle --reset flag: delete existing store and metadata before re-indexing
      if (options.reset) {
        console.log(`Resetting index for store: ${storeId}`);
        await store.deleteStore(storeId);
        const metaStoreForReset = new MetaStore();
        await metaStoreForReset.load();
        metaStoreForReset.deleteByPrefix(indexRoot);
        await metaStoreForReset.save();

        console.log("Existing index removed. Re-indexing...");

        // Ensure grammars are present before re-indexing
        await ensureGrammars();
      }

      await ensureStoreExists(store, storeId);
      const fileSystem = createFileSystem({
        ignorePatterns: DEFAULT_IGNORE_PATTERNS,
      });
      const metaStore = new MetaStore();

      const { spinner, onProgress } = createIndexingSpinner(
        indexRoot,
        "Indexing...",
      );
      try {
        try {
          await store.retrieve(storeId);
        } catch {
          await store.create({
            name: storeId,
            description: "osgrep local index",
          });
        }
        const result = await initialSync(
          store,
          fileSystem,
          storeId,
          indexRoot,
          options.dryRun,
          onProgress,
          metaStore,
        );

        if (options.dryRun) {
          spinner.succeed(
            `Dry run complete (${result.processed}/${result.total}) • would have indexed ${result.indexed}`,
          );
          if (PROFILE_ENABLED && typeof store.getProfile === "function") {
            console.log("[profile] local store:", store.getProfile());
          }
          console.log(
            formatDryRunSummary(result, {
              actionDescription: "would have indexed",
              includeTotal: true,
            }),
          );
          await gracefulExit();
          return;
        }

        // Wait for all indexing to complete
        while (true) {
          const info = await store.getInfo(storeId);
          spinner.text = `Indexing ${info.counts.pending + info.counts.in_progress} file(s)`;
          if (info.counts.pending === 0 && info.counts.in_progress === 0) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        spinner.succeed(
          `Indexing complete (${result.processed}/${result.total}) • indexed ${result.indexed}`,
        );
        if (PROFILE_ENABLED && typeof store.getProfile === "function") {
          console.log("[profile] local store:", store.getProfile());
        }
      } catch (e) {
        spinner.fail("Indexing failed");
        throw e;
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to index:", message);
      process.exitCode = 1;
      await gracefulExit(1);
    }
    await gracefulExit();
  });
