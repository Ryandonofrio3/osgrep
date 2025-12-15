/**
 * Types for the retrieval augmentation (--expand) feature.
 *
 * This feature transforms osgrep from "find relevant chunks" to
 * "build understanding context" by following symbol references,
 * finding callers, and including neighboring files.
 */

import type { ChunkType } from "../store/types";

/**
 * Strategy for expanding search results.
 * - symbols: Follow referenced_symbols → defined_symbols
 * - callers: Reverse lookup - who references my defined_symbols
 * - neighbors: Same directory files (anchor chunks)
 * - coexports: Files that export symbols I import
 */
export type ExpandStrategy = "symbols" | "callers" | "neighbors" | "coexports";

/**
 * Options for result expansion.
 */
export interface ExpandOptions {
  /** Maximum traversal depth (default: 1) */
  maxDepth?: number;
  /** Maximum number of expanded chunks to return (default: 20) */
  maxExpanded?: number;
  /** Maximum token budget for expanded results (default: unlimited) */
  maxTokens?: number;
  /** Which strategies to use (default: all) */
  strategies?: ExpandStrategy[];
}

/**
 * A single expanded chunk with relationship metadata.
 */
export interface ExpansionNode {
  /** The actual chunk data */
  chunk: ChunkType;
  /** How this chunk is related to the original results */
  relationship: ExpandStrategy;
  /** Human-readable explanation of the relationship */
  via: string;
  /** How many hops from the original result */
  depth: number;
  /** Relevance score (higher = more relevant, decays with depth) */
  score: number;
}

/**
 * Statistics about the expansion process.
 */
export interface ExpansionStats {
  /** Number of symbols successfully resolved to definitions */
  symbolsResolved: number;
  /** Number of callers found */
  callersFound: number;
  /** Number of neighbor files added */
  neighborsAdded: number;
  /** Total chunks in the expanded result */
  totalChunks: number;
  /** Estimated total tokens in the result */
  totalTokens: number;
  /** Remaining token budget (if maxTokens was set) */
  budgetRemaining?: number;
}

/**
 * The result of expanding search results.
 */
export interface ExpandedResult {
  /** The original search query */
  query: string;
  /** Original search results (unchanged) */
  original: ChunkType[];
  /** Expanded chunks with relationship metadata */
  expanded: ExpansionNode[];
  /** Whether any limit was hit during expansion */
  truncated: boolean;
  /** Expansion statistics */
  stats: ExpansionStats;
}

/**
 * Internal representation of a chunk for expansion processing.
 * Contains the raw data needed for symbol/caller resolution.
 */
export interface ExpansionChunk {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  definedSymbols: string[];
  referencedSymbols: string[];
  imports: string[];
  exports: string[];
  isAnchor: boolean;
  role?: string;
  complexity?: number;
}
