/**
 * Expander - Retrieval augmentation for osgrep search results.
 *
 * Transforms search results from "find relevant chunks" to "build understanding context"
 * by following symbol references, finding callers, and including neighboring files.
 *
 * Design Principles:
 * 1. Hot Path Stays Hot - No overhead when --expand is not used
 * 2. Language Agnostic - Uses existing Tree-sitter extracted symbols, no import parsing
 * 3. Graceful Degradation - Partial expansion is fine, never fail the search
 * 4. Token Budget Aware - Respects LLM context limits
 */

import * as path from "node:path";
import type { Table } from "@lancedb/lancedb";
import type { ChunkType } from "../store/types";
import type { VectorDB } from "../store/vector-db";
import type {
  ExpandedResult,
  ExpandOptions,
  ExpansionNode,
  ExpansionStats,
} from "./expansion-types";

/** Default options for expansion */
const DEFAULT_OPTIONS: Required<ExpandOptions> = {
  maxDepth: 1,
  maxExpanded: 20,
  maxTokens: 0, // 0 = unlimited
  strategies: ["symbols", "callers", "neighbors"],
};

/** Tokens per character ratio (rough estimate for code) */
const TOKENS_PER_CHAR = 0.25;

/**
 * Escape a string for use in SQL WHERE clauses.
 */
function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}

/**
 * Convert LanceDB array fields to string arrays.
 */
function toStrArray(val?: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val.filter((v) => typeof v === "string");
  }
  if (typeof (val as any).toArray === "function") {
    try {
      const arr = (val as any).toArray();
      if (Array.isArray(arr)) return arr.filter((v) => typeof v === "string");
      return Array.from(arr || []).filter((v) => typeof v === "string");
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Estimate token count for a string.
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length * TOKENS_PER_CHAR);
}

/**
 * Calculate file proximity score between two paths.
 * Higher score = more related (same directory > nearby > distant).
 */
function fileProximity(fromPath: string, toPath: string): number {
  if (fromPath === toPath) return 0; // Same file, skip

  const fromParts = fromPath.split("/");
  const toParts = toPath.split("/");

  let common = 0;
  for (let i = 0; i < Math.min(fromParts.length, toParts.length); i++) {
    if (fromParts[i] === toParts[i]) common++;
    else break;
  }

  // More common path segments = higher score
  return common / Math.max(fromParts.length, toParts.length);
}

/**
 * Extract import path hints from import strings.
 * e.g., "../auth/handler" -> "auth/handler"
 */
function extractPathHint(importStr: string): string | null {
  // Skip node_modules imports
  if (!importStr.startsWith(".") && !importStr.startsWith("/")) return null;

  // Remove relative prefix and extension
  return importStr
    .replace(/^\.\.?\//, "")
    .replace(/\.[^/.]+$/, "")
    .split("/")
    .slice(-2)
    .join("/");
}

export class Expander {
  constructor(private db: VectorDB) {}

  /**
   * Expand search results to include related chunks.
   *
   * @param results Original search results
   * @param query The original search query
   * @param opts Expansion options
   * @returns Expanded results with relationship metadata
   */
  async expand(
    results: ChunkType[],
    query: string,
    opts: ExpandOptions = {},
  ): Promise<ExpandedResult> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    const { maxDepth, maxExpanded, maxTokens, strategies } = options;

    const stats: ExpansionStats = {
      symbolsResolved: 0,
      callersFound: 0,
      neighborsAdded: 0,
      totalChunks: results.length,
      totalTokens: 0,
    };

    // Track seen chunk IDs to avoid duplicates
    const seen = new Set<string>();
    for (const r of results) {
      const id = this.getChunkId(r);
      if (id) seen.add(id);
      stats.totalTokens += estimateTokens(r.text || "");
    }

    // Token budget tracking
    let budgetRemaining = maxTokens > 0 ? maxTokens - stats.totalTokens : Infinity;

    let table: Table;
    try {
      table = await this.db.ensureTable();
    } catch {
      // Database not ready, return original results
      return {
        query,
        original: results,
        expanded: [],
        truncated: false,
        stats,
      };
    }

    const allExpanded: ExpansionNode[] = [];
    let truncated = false;

    // Multi-hop expansion using BFS
    let frontier: { chunk: ChunkType; depth: number; score: number }[] = results.map(
      (r) => ({
        chunk: r,
        depth: 0,
        score: 1.0,
      }),
    );

    for (let depth = 1; depth <= maxDepth; depth++) {
      if (truncated || budgetRemaining <= 0) break;

      const nextFrontier: typeof frontier = [];

      for (const node of frontier) {
        if (allExpanded.length >= maxExpanded || budgetRemaining <= 0) {
          truncated = true;
          break;
        }

        // Symbol resolution (Strategy 1)
        if (strategies.includes("symbols")) {
          const symbolNodes = await this.expandSymbols(
            table,
            node.chunk,
            node.score,
            depth,
            seen,
            maxExpanded - allExpanded.length,
            budgetRemaining,
          );

          for (const n of symbolNodes) {
            if (allExpanded.length >= maxExpanded || budgetRemaining <= 0) {
              truncated = true;
              break;
            }
            allExpanded.push(n);
            nextFrontier.push({ chunk: n.chunk, depth, score: n.score });
            stats.symbolsResolved++;
            const tokens = estimateTokens(n.chunk.text || "");
            stats.totalTokens += tokens;
            budgetRemaining -= tokens;
          }
        }

        // Caller resolution (Strategy 2)
        if (strategies.includes("callers") && !truncated) {
          const callerNodes = await this.expandCallers(
            table,
            node.chunk,
            node.score,
            depth,
            seen,
            maxExpanded - allExpanded.length,
            budgetRemaining,
          );

          for (const n of callerNodes) {
            if (allExpanded.length >= maxExpanded || budgetRemaining <= 0) {
              truncated = true;
              break;
            }
            allExpanded.push(n);
            nextFrontier.push({ chunk: n.chunk, depth, score: n.score });
            stats.callersFound++;
            const tokens = estimateTokens(n.chunk.text || "");
            stats.totalTokens += tokens;
            budgetRemaining -= tokens;
          }
        }

        // Neighbor expansion (Strategy 3) - only at depth 1
        if (strategies.includes("neighbors") && depth === 1 && !truncated) {
          const neighborNodes = await this.expandNeighbors(
            table,
            node.chunk,
            node.score,
            depth,
            seen,
            maxExpanded - allExpanded.length,
            budgetRemaining,
          );

          for (const n of neighborNodes) {
            if (allExpanded.length >= maxExpanded || budgetRemaining <= 0) {
              truncated = true;
              break;
            }
            allExpanded.push(n);
            stats.neighborsAdded++;
            const tokens = estimateTokens(n.chunk.text || "");
            stats.totalTokens += tokens;
            budgetRemaining -= tokens;
          }
        }
      }

      frontier = nextFrontier;
    }

    // Final sort by score (descending)
    allExpanded.sort((a, b) => b.score - a.score);

    stats.totalChunks = results.length + allExpanded.length;
    if (maxTokens > 0) {
      stats.budgetRemaining = Math.max(0, budgetRemaining);
    }

    return {
      query,
      original: results,
      expanded: allExpanded,
      truncated,
      stats,
    };
  }

  /**
   * Expand by resolving referenced symbols to their definitions.
   */
  private async expandSymbols(
    table: Table,
    chunk: ChunkType,
    parentScore: number,
    depth: number,
    seen: Set<string>,
    maxToAdd: number,
    budgetRemaining: number,
  ): Promise<ExpansionNode[]> {
    const refs = toStrArray(chunk.referenced_symbols);
    if (refs.length === 0) return [];

    const chunkPath = this.getChunkPath(chunk);
    const importHints = toStrArray(chunk.imports).map(extractPathHint).filter(Boolean) as string[];
    const expanded: ExpansionNode[] = [];

    // Limit symbols to process per chunk
    const symbolsToProcess = refs.slice(0, 10);

    for (const symbol of symbolsToProcess) {
      if (expanded.length >= maxToAdd || budgetRemaining <= 0) break;

      try {
        // Query for chunks that define this symbol
        const results = await table
          .query()
          .where(`array_contains(defined_symbols, '${escapeSql(symbol)}')`)
          .limit(10)
          .toArray();

        // Sort by proximity to requesting file (import hints help disambiguate)
        const sorted = results
          .map((r: any) => ({
            record: r,
            proximity: fileProximity(chunkPath, r.path || ""),
            importMatch: importHints.some((h) => (r.path || "").includes(h)),
          }))
          .sort((a, b) => {
            // Import matches first
            if (a.importMatch !== b.importMatch) return b.importMatch ? 1 : -1;
            // Then by proximity
            return b.proximity - a.proximity;
          })
          .slice(0, 3);

        for (const { record, proximity } of sorted) {
          const id = record.id;
          if (!id || seen.has(id)) continue;

          const tokens = estimateTokens(record.content || record.display_text || "");
          if (tokens > budgetRemaining) continue;

          seen.add(id);
          budgetRemaining -= tokens;

          const mappedChunk = this.mapRecordToChunk(record);
          const score = parentScore * 0.7 * (0.5 + proximity * 0.5);

          expanded.push({
            chunk: mappedChunk,
            relationship: "symbols",
            via: symbol,
            depth,
            score,
          });

          if (expanded.length >= maxToAdd) break;
        }
      } catch (err) {
        // Graceful degradation - skip this symbol
        continue;
      }
    }

    return expanded;
  }

  /**
   * Expand by finding callers (chunks that reference this chunk's defined symbols).
   */
  private async expandCallers(
    table: Table,
    chunk: ChunkType,
    parentScore: number,
    depth: number,
    seen: Set<string>,
    maxToAdd: number,
    budgetRemaining: number,
  ): Promise<ExpansionNode[]> {
    const defined = toStrArray(chunk.defined_symbols);
    if (defined.length === 0) return [];

    const chunkPath = this.getChunkPath(chunk);
    const expanded: ExpansionNode[] = [];

    // Limit symbols to process
    const symbolsToProcess = defined.slice(0, 5);

    for (const symbol of symbolsToProcess) {
      if (expanded.length >= maxToAdd || budgetRemaining <= 0) break;

      try {
        // Find chunks that reference this symbol
        const results = await table
          .query()
          .where(`array_contains(referenced_symbols, '${escapeSql(symbol)}')`)
          .limit(10)
          .toArray();

        // Sort by proximity
        const sorted = results
          .map((r: any) => ({
            record: r,
            proximity: fileProximity(chunkPath, r.path || ""),
          }))
          .filter((x) => x.record.path !== chunkPath) // Exclude same file
          .sort((a, b) => b.proximity - a.proximity)
          .slice(0, 3);

        for (const { record, proximity } of sorted) {
          const id = record.id;
          if (!id || seen.has(id)) continue;

          const tokens = estimateTokens(record.content || record.display_text || "");
          if (tokens > budgetRemaining) continue;

          seen.add(id);
          budgetRemaining -= tokens;

          const mappedChunk = this.mapRecordToChunk(record);
          const score = parentScore * 0.6 * (0.5 + proximity * 0.5);

          expanded.push({
            chunk: mappedChunk,
            relationship: "callers",
            via: `uses ${symbol}`,
            depth,
            score,
          });

          if (expanded.length >= maxToAdd) break;
        }
      } catch {
        continue;
      }
    }

    return expanded;
  }

  /**
   * Expand by including anchor chunks from the same directory.
   */
  private async expandNeighbors(
    table: Table,
    chunk: ChunkType,
    parentScore: number,
    depth: number,
    seen: Set<string>,
    maxToAdd: number,
    budgetRemaining: number,
  ): Promise<ExpansionNode[]> {
    const chunkPath = this.getChunkPath(chunk);
    if (!chunkPath) return [];

    const dir = path.dirname(chunkPath);
    const expanded: ExpansionNode[] = [];

    try {
      // Get anchor chunks from same directory (file summaries)
      const results = await table
        .query()
        .where(`path LIKE '${escapeSql(dir)}/%' AND is_anchor = true`)
        .limit(5)
        .toArray();

      for (const record of results as any[]) {
        if (expanded.length >= maxToAdd || budgetRemaining <= 0) break;

        const id = record.id;
        if (!id || seen.has(id)) continue;
        if (record.path === chunkPath) continue; // Skip same file

        const tokens = estimateTokens(record.content || record.display_text || "");
        if (tokens > budgetRemaining) continue;

        seen.add(id);
        budgetRemaining -= tokens;

        const mappedChunk = this.mapRecordToChunk(record);

        expanded.push({
          chunk: mappedChunk,
          relationship: "neighbors",
          via: "same directory",
          depth,
          score: parentScore * 0.4,
        });
      }
    } catch {
      // Graceful degradation
    }

    return expanded;
  }

  /**
   * Get a unique ID for a chunk.
   */
  private getChunkId(chunk: ChunkType): string {
    if (chunk.metadata && typeof (chunk.metadata as any).hash === "string") {
      return (chunk.metadata as any).hash;
    }
    const p = this.getChunkPath(chunk);
    const start = chunk.generated_metadata?.start_line ?? 0;
    return `${p}:${start}`;
  }

  /**
   * Get the file path from a chunk.
   */
  private getChunkPath(chunk: ChunkType): string {
    if (chunk.metadata && typeof (chunk.metadata as any).path === "string") {
      return (chunk.metadata as any).path;
    }
    return "";
  }

  /**
   * Map a LanceDB record to ChunkType.
   */
  private mapRecordToChunk(record: any): ChunkType {
    const startLine = record.start_line ?? 0;
    const endLine = typeof record.end_line === "number" ? record.end_line : startLine;
    const numLines = Math.max(1, endLine - startLine + 1);

    // Clean content (strip headers)
    const content = record.display_text || record.content || "";
    const lines = content.split("\n");
    let startIdx = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith("// File:") || line.startsWith("File:")) continue;
      if (line.startsWith("Imports:") || line.startsWith("Exports:")) continue;
      if (line === "---" || line === "(anchor)") continue;
      if (line.startsWith("//")) continue;
      startIdx = i;
      break;
    }

    const bodyLines = lines.slice(startIdx);
    const MAX_LINES = 15;
    let truncatedText = bodyLines.slice(0, MAX_LINES).join("\n");
    if (bodyLines.length > MAX_LINES) {
      truncatedText += `\n... (+${bodyLines.length - MAX_LINES} more lines)`;
    }

    return {
      type: "text",
      text: truncatedText.trim(),
      score: 0,
      metadata: {
        path: record.path || "",
        hash: record.hash || "",
        is_anchor: !!record.is_anchor,
      },
      generated_metadata: {
        start_line: startLine,
        end_line: endLine,
        num_lines: numLines,
        type: record.chunk_type,
      },
      complexity: record.complexity,
      is_exported: record.is_exported,
      role: record.role,
      parent_symbol: record.parent_symbol,
      defined_symbols: toStrArray(record.defined_symbols),
      referenced_symbols: toStrArray(record.referenced_symbols),
      imports: toStrArray(record.imports),
      exports: toStrArray(record.exports),
    };
  }
}
