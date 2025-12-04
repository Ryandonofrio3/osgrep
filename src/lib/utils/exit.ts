import { workerPool } from "../workers/pool";
import { runCleanup } from "./cleanup";

export async function gracefulExit(code = 0): Promise<void> {
  try {
    await workerPool.destroy();
  } catch (err) {
    console.error("[exit] Failed to destroy worker pool:", err);
  }

  await runCleanup();

  process.exit(code);
}
