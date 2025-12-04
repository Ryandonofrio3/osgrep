import * as fs from "node:fs";
import * as path from "node:path";

function describeLockHolder(lockPath: string): string {
  try {
    const contents = fs.readFileSync(lockPath, "utf-8").trim();
    return contents ? contents : "unknown holder";
  } catch {
    return "unknown holder";
  }
}

export type LockHandle = {
  release: () => Promise<void>;
};

export async function acquireWriterLock(lockDir: string): Promise<LockHandle> {
  const lockPath = path.join(lockDir, "LOCK");
  try {
    await fs.promises.writeFile(
      lockPath,
      `${process.pid}\n${new Date().toISOString()}`,
      { flag: "wx" },
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      const holder = describeLockHolder(lockPath);
      throw new Error(
        `.osgrep lock already held (${holder}). Another indexing process is running or the lock must be cleared.`,
      );
    }
    throw err;
  }

  return {
    release: async () => {
      try {
        await fs.promises.unlink(lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          console.warn("[lock] Failed to remove lock:", err);
        }
      }
    },
  };
}
