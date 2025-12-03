import { relative } from "node:path";
import ora, { type Ora } from "ora";

interface IndexingSpinner {
  spinner: Ora;
  onProgress: (info: InitialSyncProgress) => void;
}

export interface IndexingSpinnerOptions {
  verbose?: boolean;
}

export interface InitialSyncProgress {
  processed: number;
  indexed: number;
  total: number;
  /** Number of files that need re-indexing (changed or new) */
  candidates?: number;
  filePath?: string;
  phase?: "scanning" | "indexing";
  error?: string;
}

export interface InitialSyncResult {
  processed: number;
  indexed: number;
  total: number;
  skipped?: number;
  errors?: string[];
}

/**
 * Converts an absolute `filePath` into a path relative to `root` when possible,
 * keeping absolute fallbacks for paths outside the repo.
 *
 * @param root The root directory of the repository
 * @param filePath The path to the file to format
 * @returns The formatted path
 */
function formatRelativePath(root: string, filePath?: string): string {
  if (!filePath) {
    return "";
  }
  return filePath.startsWith(root) ? relative(root, filePath) : filePath;
}

/**
 * Creates a shared spinner + progress callback pair that keeps the CLI UI
 * consistent across commands running `initialSync`.
 *
 * @param root The root directory of the repository
 * @param label The label to use for the spinner
 * @param options Options for the spinner
 * @returns The spinner and progress callback pair
 */
export function createIndexingSpinner(
  root: string,
  label = "Indexing files...",
  options: IndexingSpinnerOptions = {},
): IndexingSpinner {
  const { verbose = false } = options;
  const spinner = ora({ text: label }).start();
  const seenFiles = new Set<string>();

  return {
    spinner,
    onProgress(info) {
      const rel = formatRelativePath(root, info.filePath);

      if (verbose && info.filePath && !seenFiles.has(info.filePath)) {
        seenFiles.add(info.filePath);
        // In verbose mode, log each file on its own line
        spinner.stop();
        if (info.error) {
          console.log(`  ✗ ${rel} (${info.error})`);
        } else {
          console.log(`  → ${rel}`);
        }
        spinner.start();
      }

      const suffix = rel ? ` ${rel}` : "";
      const phaseLabel = info.phase === "scanning" ? "Scanning" : "Indexing";
      // During scanning: show processed/total
      // During indexing: show indexed/candidates (how many need re-indexing)
      const progressCount =
        info.phase === "scanning" ? info.processed : info.indexed;
      const denominator =
        info.phase === "scanning"
          ? info.total
          : info.candidates ?? info.total;
      spinner.text = `${phaseLabel} files (${progressCount}/${denominator})${suffix}`;
    },
  };
}

/**
 * Produces a single-line summary describing what a dry-run sync would have done.
 *
 * @param result The result of the initial sync
 * @param actionDescription The description of the action
 * @param includeTotal Whether to include the total number of files
 * @returns The formatted summary
 */
export function formatDryRunSummary(
  result: InitialSyncResult,
  {
    actionDescription,
    includeTotal = false,
  }: { actionDescription: string; includeTotal?: boolean },
): string {
  const totalSuffix = includeTotal ? " in total" : "";
  return `Dry run: ${actionDescription} ${result.processed} files${totalSuffix}, would have indexed ${result.indexed} changed or new files`;
}
