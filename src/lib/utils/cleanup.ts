type CleanupTask = () => void | Promise<void>;

const cleanupTasks = new Set<CleanupTask>();

export function registerCleanup(task: CleanupTask): () => void {
  cleanupTasks.add(task);
  return () => {
    cleanupTasks.delete(task);
  };
}

export async function runCleanup(): Promise<void> {
  for (const task of Array.from(cleanupTasks)) {
    try {
      await task();
    } catch (err) {
      console.error("[cleanup] Failed to run cleanup task:", err);
    }
  }
  cleanupTasks.clear();
}
