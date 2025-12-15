import * as fs from "node:fs";
import ora from "ora";
import { PATHS } from "../../config";

export interface SetupPaths {
  root: string;
  grammars: string;
}

export interface SetupStatus extends SetupPaths {
  createdDirs: boolean;
}

function getPaths(): SetupPaths {
  return {
    root: PATHS.globalRoot,
    grammars: PATHS.grammars,
  };
}

/**
 * Idempotent helper that ensures osgrep directories and models exist.
 * Returns status about work performed so callers can decide what to show.
 */
export async function ensureSetup({
  silent,
}: {
  silent?: boolean;
} = {}): Promise<SetupStatus> {
  const paths = getPaths();
  const dirs = [paths.root, paths.grammars];

  const needsDirs = dirs.some((dir) => !fs.existsSync(dir));
  let createdDirs = false;

  const dirSpinner =
    !silent && needsDirs
      ? ora("Preparing osgrep directories...").start()
      : null;
  try {
    if (needsDirs) {
      dirs.forEach((dir) => {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          createdDirs = true;
        }
      });
    }
    dirSpinner?.succeed("Directories ready");
  } catch (error) {
    dirSpinner?.fail("Failed to prepare directories");
    throw error;
  }

  return { ...paths, createdDirs };
}
