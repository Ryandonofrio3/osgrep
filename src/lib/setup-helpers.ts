import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ora from "ora";
import { areModelsDownloaded, downloadModels } from "./model-loader";

export interface SetupPaths {
  root: string;
  models: string;
  data: string;
  grammars: string;
}

export interface SetupStatus extends SetupPaths {
  createdDirs: boolean;
  downloadedModels: boolean;
}

function getPaths(): SetupPaths {
  const home = os.homedir();
  const root = path.join(home, ".osgrep");
  return {
    root,
    models: path.join(root, "models"),
    data: path.join(root, "data"),
    grammars: path.join(root, "grammars"),
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
  const dirs = [paths.root, paths.models, paths.data, paths.grammars];

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

  const modelsPresent = areModelsDownloaded();
  let downloadedModels = false;

  if (!modelsPresent) {
    const modelSpinner = !silent
      ? ora("Downloading models (first run)...").start()
      : null;
    try {
      await downloadModels();
      downloadedModels = true;
      modelSpinner?.succeed("Models downloaded and ready");
    } catch (error) {
      modelSpinner?.fail("Failed to download models");
      throw error;
    }
  }

  return { ...paths, createdDirs, downloadedModels };
}
