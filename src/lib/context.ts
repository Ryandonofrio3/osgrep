import {
  type FileSystem,
  type FileSystemOptions,
  NodeFileSystem,
} from "./file";
import { type Git, NodeGit } from "./git";
import { LocalStore } from "./local-store";
import type { Store } from "./store";

/**
 * Creates a Store instance
 */
export async function createStore(): Promise<Store> {
  return new LocalStore();
}

/**
 * Creates a Git instance
 */
export function createGit(): Git {
  return new NodeGit();
}

/**
 * Creates a FileSystem instance
 */
export function createFileSystem(
  options: FileSystemOptions = { ignorePatterns: [] },
): FileSystem {
  return new NodeFileSystem(createGit(), options);
}
