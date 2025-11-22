import type { Store } from "./store";

export async function ensureStoreExists(
  store: Store,
  storeId: string,
): Promise<void> {
  try {
    await store.retrieve(storeId);
  } catch {
    await store.create({
      name: storeId,
      description: "osgrep local index",
    });
  }
}

export async function isStoreEmpty(
  store: Store,
  storeId: string,
): Promise<boolean> {
  try {
    for await (const _ of store.listFiles(storeId)) {
      return false;
    }
  } catch (_err) {
    // If we can't list files, treat it as empty/missing
  }
  return true;
}
