export function escapeSqlString(str: string): string {
  // LanceDB (via DataFusion) treats backslashes literally in standard strings.
  // We only need to escape single quotes by doubling them.
  return str.replace(/'/g, "''");
}

/**
 * Normalizes a path to use forward slashes, ensuring consistency across platforms.
 * @param p The path to normalize
 * @returns The normalized path with forward slashes
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
