import * as path from "node:path";
import { Command } from "commander";
import { ensureGrammars } from "../lib/index/grammar-loader";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/index/sync-helpers";
import { initialSync } from "../lib/index/syncer";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

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
    const options: {
      store?: string;
      dryRun: boolean;
      path: string;
      reset: boolean;
    } = cmd.optsWithGlobals();
    let vectorDb: VectorDB | null = null;

    try {
      await ensureSetup();
      const indexRoot = options.path
        ? path.resolve(options.path)
        : process.cwd();
      const projectRoot = findProjectRoot(indexRoot) ?? indexRoot;
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);

      if (options.reset) {
        console.log(
          `Resetting index at ${paths.osgrepDir} (waiting for lock)...`,
        );
        // We do NOT manually drop/rm here anymore to avoid race conditions.
        // The syncer handles it inside the lock.
      }

      // Ensure grammars are present before indexing (silent if already exist)
      await ensureGrammars(console.log, { silent: true });

      const { spinner, onProgress } = createIndexingSpinner(
        projectRoot,
        "Indexing...",
      );
      try {
        const result = await initialSync({
          projectRoot,
          dryRun: options.dryRun,
          reset: options.reset,
          onProgress,
        });

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

        const failedSuffix =
          result.failedFiles > 0 ? ` • ${result.failedFiles} failed` : "";
        spinner.succeed(
          `Indexing complete (${result.processed}/${result.total}) • indexed ${result.indexed}${failedSuffix}`,
        );
      } catch (e) {
        spinner.fail("Indexing failed");
        throw e;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to index:", message);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch (err) {
          console.error("Failed to close VectorDB:", err);
        }
      }
      const code =
        typeof process.exitCode === "number"
          ? process.exitCode
          : process.exitCode === undefined
            ? 0
            : 1;
      await gracefulExit(code);
    }
  });
