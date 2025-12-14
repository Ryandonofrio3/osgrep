import type { Table } from "@lancedb/lancedb";
import { CONFIG } from "../../config";
import type {
  ChunkType,
  SearchFilter,
  SearchResponse,
  VectorRecord,
} from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { escapeSqlString, normalizePath } from "../utils/filter-builder";
import { encodeQuery, rerank } from "../workers/orchestrator";

export class Searcher {
  constructor(private db: VectorDB) {}

  private static readonly PRE_RERANK_K_MULT = 5;
  private static readonly PRE_RERANK_K_MIN = 500;
  private static readonly RERANK_CANDIDATES_K = 80;
  private static readonly FUSED_WEIGHT = 0.5;
  private static readonly MAX_PER_FILE = 3;
  private static readonly FTS_STOPWORDS = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "before",
    "but",
    "by",
    "do",
    "does",
    "for",
    "from",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "our",
    "that",
    "the",
    "their",
    "then",
    "this",
    "to",
    "we",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "with",
  ]);

  private static normalizeFtsQuery(query: string): string {
    const tokens = query
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, " ")
      .split(/\s+/g)
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => t.length >= 3)
      .filter((t) => !Searcher.FTS_STOPWORDS.has(t));

    // Keep the query short to avoid pathological FTS parsing / scoring.
    return tokens.slice(0, 16).join(" ");
  }

  private mapRecordToChunk(
    record: Partial<VectorRecord>,
    score: number,
  ): ChunkType {
    const toStrArray = (val?: unknown): string[] => {
      if (!val) return [];
      if (Array.isArray(val)) {
        return val.filter((v) => typeof v === "string");
      }
      if (typeof (val as any).toArray === "function") {
        try {
          const arr = (val as any).toArray();
          if (Array.isArray(arr))
            return arr.filter((v) => typeof v === "string");
          return Array.from(arr || []).filter((v) => typeof v === "string");
        } catch {
          return [];
        }
      }
      return [];
    };

    // 1. Aggressive Header Stripping
    // Prefer display_text (includes breadcrumbs/imports) but strip them for humans
    const cleanCode = record.display_text || record.content || "";

    // Split by lines
    const lines = cleanCode.split("\n");
    let startIdx = 0;

    // Skip lines that look like headers or imports
    // Heuristic: skip until we hit the first line that looks like code or a symbol breadcrumb
    let inImportBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith("// File:")) continue;
      if (line.startsWith("File:")) continue; // Sometimes "File: ..." without comment
      if (line.startsWith("Imports:") || line.startsWith("Exports:")) continue;
      if (line === "---" || line === "(anchor)") continue;
      if (line.startsWith("//")) continue; // other header comments

      if (inImportBlock) {
        if (line.endsWith(";")) inImportBlock = false;
        continue;
      }
      if (line.startsWith("import ")) {
        inImportBlock = !line.endsWith(";");
        continue;
      }
      if (line.startsWith("from ")) continue; // Python/JS

      // If we hit something else, this is likely the start of code
      startIdx = i;
      break;
    }

    // Reassemble and Truncate
    const bodyLines = lines.slice(startIdx);
    const MAX_LINES = 15;
    let truncatedText = bodyLines.slice(0, MAX_LINES).join("\n");
    if (bodyLines.length > MAX_LINES) {
      truncatedText += `\n... (+${bodyLines.length - MAX_LINES} more lines)`;
    }

    // 2. Cap the Symbol Lists
    const MAX_SYMBOLS = 10;
    const truncate = (arr?: unknown) => {
      const arrVal = toStrArray(arr);
      if (arrVal.length <= MAX_SYMBOLS) return arrVal;
      return [
        ...arrVal.slice(0, MAX_SYMBOLS),
        `... (+${arrVal.length - MAX_SYMBOLS} more)`,
      ];
    };

    const definedSymbols = truncate(record.defined_symbols);
    const referencedSymbols = truncate(record.referenced_symbols);
    const imports = truncate(record.imports);
    const exports = truncate(record.exports);

    const startLine = record.start_line ?? 0;
    const endLine =
      typeof record.end_line === "number" ? record.end_line : startLine;

    const numLines = Math.max(1, endLine - startLine + 1);

    return {
      type: "text",
      text: truncatedText.trim(),
      score,
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

      // Truncate lists to save tokens
      defined_symbols: definedSymbols,
      referenced_symbols: referencedSymbols,
      imports,
      exports,

      // Remove 'context' field entirely from JSON output
      // context: record.context_prev ? [record.context_prev] : [],
    };
  }

  private applyStructureBoost(
    record: Partial<VectorRecord>,
    score: number,
  ): number {
    let adjusted = score;

    // Anchor penalty (anchors are recall helpers, not results)
    if (record.is_anchor) {
      adjusted *= 0.99;
    }

    const pathStr = (record.path || "").toLowerCase();

    // Use path-segment and filename patterns to avoid false positives like "latest"
    const isTestPath =
      /(^|\/)(__tests__|tests?|specs?|benchmark)(\/|$)/i.test(pathStr) ||
      /\.(test|spec)\.[cm]?[jt]sx?$/i.test(pathStr);

    if (isTestPath) {
      adjusted *= 0.5;
    }
    // Tooling/docs-like paths often contain lots of "how do we..." text and can
    // dominate semantic queries (e.g., `tools/eval.ts`).
    if (/(^|\/)(tools|scripts|experiments)(\/|$)/i.test(pathStr)) {
      adjusted *= 0.35;
    }
    if (
      pathStr.endsWith(".md") ||
      pathStr.endsWith(".json") ||
      pathStr.endsWith(".lock") ||
      pathStr.includes("/docs/")
    ) {
      adjusted *= 0.6;
    }

    return adjusted;
  }

  private deduplicateResults(
    results: { record: VectorRecord; score: number }[],
  ): { record: VectorRecord; score: number }[] {
    const seenIds = new Set<string>();
    const seenContent = new Map<string, { start: number; end: number }[]>();
    const deduped: { record: VectorRecord; score: number }[] = [];

    for (const item of results) {
      // Hard Dedup: ID
      if (item.record.id && seenIds.has(item.record.id)) continue;
      if (item.record.id) seenIds.add(item.record.id);

      // Overlap Dedup
      const path = item.record.path || "";
      const start = item.record.start_line || 0;
      const end = item.record.end_line || 0;
      const range = end - start;

      const existing = seenContent.get(path) || [];
      let isOverlapping = false;

      for (const other of existing) {
        const otherRange = other.end - other.start;
        const overlapStart = Math.max(start, other.start);
        const overlapEnd = Math.min(end, other.end);
        const overlap = Math.max(0, overlapEnd - overlapStart);

        // If overlap is > 50% of the smaller chunk
        if (overlap > 0.5 * Math.min(range, otherRange)) {
          isOverlapping = true;
          break;
        }
      }

      if (!isOverlapping) {
        deduped.push(item);
        existing.push({ start, end });
        seenContent.set(path, existing);
      }
    }
    return deduped;
  }

  private ftsIndexChecked = false;

  async search(
    query: string,
    top_k?: number,
    options?: { rerank?: boolean },
    filters?: SearchFilter,
    pathPrefix?: string,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    const finalLimitRaw = top_k ?? 10;
    const finalLimit =
      Number.isFinite(finalLimitRaw) && finalLimitRaw > 0 ? finalLimitRaw : 10;
    const doRerank = options?.rerank ?? true;

    if (signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }

    const {
      dense: queryVector,
      colbert: queryMatrixRaw,
      colbertDim,
    } = await encodeQuery(query);

    if (signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }

    if (colbertDim !== CONFIG.COLBERT_DIM) {
      throw new Error(
        `[Searcher] Query ColBERT dim (${colbertDim}) != Config (${CONFIG.COLBERT_DIM})`,
      );
    }

    const whereClauseParts: string[] = [];
    if (pathPrefix) {
      whereClauseParts.push(
        `path LIKE '${escapeSqlString(normalizePath(pathPrefix))}%'`,
      );
    }

    // Handle --def (definition) filter
    const defFilter = filters?.def;
    if (typeof defFilter === "string" && defFilter) {
      whereClauseParts.push(
        `array_contains(defined_symbols, '${escapeSqlString(defFilter)}')`,
      );
    }

    // Handle --ref (reference) filter
    const refFilter = filters?.ref;
    if (typeof refFilter === "string" && refFilter) {
      whereClauseParts.push(
        `array_contains(referenced_symbols, '${escapeSqlString(refFilter)}')`,
      );
    }

    const whereClause =
      whereClauseParts.length > 0 ? whereClauseParts.join(" AND ") : undefined;

    const PRE_RERANK_K = Math.max(
      finalLimit * Searcher.PRE_RERANK_K_MULT,
      Searcher.PRE_RERANK_K_MIN,
    );
    let table: Table;
    try {
      table = await this.db.ensureTable();
    } catch {
      return { data: [] };
    }

    // Ensure FTS index exists (lazy init on first search)
    if (!this.ftsIndexChecked) {
      this.ftsIndexChecked = true; // Set immediately to prevent retry spam
      try {
        await this.db.createFTSIndex();
      } catch (e) {
        console.warn("[Searcher] Failed to ensure FTS index:", e);
      }
    }

    let vectorQuery = table.vectorSearch(queryVector).limit(PRE_RERANK_K);
    if (whereClause) {
      vectorQuery = vectorQuery.where(whereClause);
    }
    const vectorResults = (await vectorQuery.toArray()) as VectorRecord[];

    let ftsResults: VectorRecord[] = [];
    try {
      const ftsText = Searcher.normalizeFtsQuery(query);
      if (!ftsText) throw new Error("Empty FTS query after normalization");
      let ftsQuery = table.search(ftsText).limit(PRE_RERANK_K);
      if (whereClause) {
        ftsQuery = ftsQuery.where(whereClause);
      }
      ftsResults = (await ftsQuery.toArray()) as VectorRecord[];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[Searcher] FTS search failed: ${msg}`);
    }

    if (signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }

    // Reciprocal Rank Fusion (vector + FTS)
    const RRF_K = 60;
    const candidateScores = new Map<string, number>();
    const docMap = new Map<string, VectorRecord>();

    vectorResults.forEach((doc, rank) => {
      const key = doc.id || `${doc.path}:${doc.chunk_index}`;
      docMap.set(key, doc);
      const score = 1.0 / (RRF_K + rank + 1);
      candidateScores.set(key, (candidateScores.get(key) || 0) + score);
    });

    ftsResults.forEach((doc, rank) => {
      const key = doc.id || `${doc.path}:${doc.chunk_index}`;
      if (!docMap.has(key)) docMap.set(key, doc);
      const score = 1.0 / (RRF_K + rank + 1);
      candidateScores.set(key, (candidateScores.get(key) || 0) + score);
    });

    const fused = Array.from(candidateScores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => docMap.get(key))
      .filter(Boolean) as VectorRecord[];

    if (fused.length === 0) {
      return { data: [] };
    }

    const rerankCandidates = fused.slice(0, Searcher.RERANK_CANDIDATES_K);

    const scores = doRerank
      ? await rerank({
            query: queryMatrixRaw,
            docs: rerankCandidates.map((doc) => ({
              colbert: (doc.colbert as Buffer | Int8Array | number[]) ?? [],
              token_ids: Array.isArray((doc as any).doc_token_ids)
                ? ((doc as any).doc_token_ids as number[])
                : typeof (doc as any).doc_token_ids?.toArray === "function"
                  ? (((doc as any).doc_token_ids.toArray() as unknown[]) ?? [])
                      .filter((v) => typeof v === "number") as number[]
                  : [],
            })),
            colbertDim,
          })
      : rerankCandidates.map((doc, idx) => {
          // If rerank is disabled, fall back to fusion ordering with structural boost
          const key = doc.id || `${doc.path}:${doc.chunk_index}`;
          const fusedScore = candidateScores.get(key) ?? 0;
          // Small tie-breaker so later items don't all share 0
          return fusedScore || 1 / (idx + 1);
        });

    type ScoredItem = {
      record: (typeof rerankCandidates)[number];
      score: number;
    };

    const scored: ScoredItem[] = rerankCandidates.map((doc, idx) => {
      const base = scores?.[idx] ?? 0;
      const key = doc.id || `${doc.path}:${doc.chunk_index}`;
      const fusedScore = candidateScores.get(key) ?? 0;
      const blended = base + Searcher.FUSED_WEIGHT * fusedScore;
      const boosted = this.applyStructureBoost(doc, blended);
      return { record: doc, score: boosted };
    });

    // Note: "boosted" was not previously declared -- fix to use "scored"
    scored.sort((a: ScoredItem, b: ScoredItem) => b.score - a.score);

    // Item 11: Intelligent Deduplication
    const uniqueScored = this.deduplicateResults(scored);

    // Item 10: Per-file diversification
    const seenFiles = new Map<string, number>();
    const diversified: ScoredItem[] = [];

    for (const item of uniqueScored) {
      const path = item.record.path || "";
      const count = seenFiles.get(path) || 0;
      if (count < Searcher.MAX_PER_FILE) {
        diversified.push(item);
        seenFiles.set(path, count + 1);
      }
      if (diversified.length >= finalLimit) break;
    }

    const finalResults = diversified.map((item: ScoredItem) => ({
      ...item.record,
      _score: item.score,
      vector: undefined,
      colbert: undefined,
    }));

    // Item 12: Score Calibration
    const maxScore = finalResults.length > 0 ? finalResults[0]._score : 1.0;

    return {
      data: finalResults.map((r: (typeof finalResults)[number]) => {
        const chunk = this.mapRecordToChunk(r, r._score || 0);

        // Normalize score relative to top result
        const normalized = maxScore > 0 ? r._score / maxScore : 0;

        let confidence: "High" | "Medium" | "Low" = "Low";
        if (normalized > 0.8) confidence = "High";
        else if (normalized > 0.5) confidence = "Medium";

        chunk.score = normalized;
        chunk.confidence = confidence;
        return chunk;
      }),
    };
  }
}
