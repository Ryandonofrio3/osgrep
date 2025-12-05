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
import { getWorkerPool } from "../workers/pool";

export class Searcher {
  constructor(private db: VectorDB) {}

  private mapRecordToChunk(
    record: Partial<VectorRecord>,
    score: number,
  ): ChunkType {
    const fullText = `${record.context_prev || ""}${record.display_text || record.content || ""}${record.context_next || ""} `;
    const startLine = record.start_line || 0;
    const endLine = record.end_line || startLine;

    return {
      type: "text",
      text: fullText,
      score,
      metadata: {
        path: record.path || "",
        hash: record.hash || "",
        is_anchor: !!record.is_anchor,
      },
      generated_metadata: {
        start_line: startLine,
        num_lines: Math.max(1, endLine - startLine + 1),
        type: record.chunk_type,
      },
    };
  }

  private applyStructureBoost(
    record: Partial<VectorRecord>,
    score: number,
  ): number {
    let adjusted = score;

    // Item 6: Anchors are recall helpers, not rank contenders
    if (record.is_anchor) {
      // Minimal penalty to break ties
      adjusted *= 0.99;
    } else {
      // Only boost non-anchors
      const chunkType = record.chunk_type || "";
      const boosted = [
        "function",
        "class",
        "method",
        "interface",
        "type_alias",
      ];
      if (boosted.includes(chunkType)) {
        adjusted *= 1.05; // Small multiplicative boost (5%)
      }
    }

    const pathStr = (record.path || "").toLowerCase();

    if (
      pathStr.includes("test") ||
      pathStr.includes("spec") ||
      pathStr.includes("__tests__")
    ) {
      adjusted *= 0.9; // Downweight tests
    }
    if (
      pathStr.endsWith(".md") ||
      pathStr.endsWith(".mdx") ||
      pathStr.endsWith(".txt") ||
      pathStr.endsWith(".json") ||
      pathStr.endsWith(".lock") ||
      pathStr.includes("/docs/")
    ) {
      adjusted *= 0.85; // Downweight docs/data
    }
    return adjusted;
  }

  async search(
    query: string,
    top_k?: number,
    _search_options?: { rerank?: boolean },
    _filters?: SearchFilter,
    pathPrefix?: string,
  ): Promise<SearchResponse> {
    const finalLimit = top_k ?? 10;

    const pool = getWorkerPool();

    const {
      dense: queryVector,
      colbert: queryMatrixRaw,
      colbertDim,
      pooled_colbert_48d: queryPooled,
    } = await pool.encodeQuery(query);

    if (colbertDim !== CONFIG.COLBERT_DIM) {
      console.warn(
        `[Searcher] Warning: Query ColBERT dim (${colbertDim}) != Config (${CONFIG.COLBERT_DIM})`,
      );
    }

    const whereClause = pathPrefix
      ? `path LIKE '${escapeSqlString(normalizePath(pathPrefix))}%'`
      : undefined;

    const PRE_RERANK_K = Math.max(finalLimit * 3, 150);
    let table: Table;
    try {
      table = await this.db.ensureTable();
    } catch {
      return { data: [] };
    }

    let vectorQuery = table.vectorSearch(queryVector).limit(PRE_RERANK_K);
    if (whereClause) {
      vectorQuery = vectorQuery.where(whereClause);
    }
    const vectorResults = (await vectorQuery.toArray()) as VectorRecord[];

    let ftsResults: VectorRecord[] = [];
    try {
      let ftsQuery = table.search(query).limit(PRE_RERANK_K);
      if (whereClause) {
        ftsQuery = ftsQuery.where(whereClause);
      }
      ftsResults = (await ftsQuery.toArray()) as VectorRecord[];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If FTS index is missing, try to create it and retry once
      if (msg.includes("FTS index not found") || msg.includes("No FTS index")) {
        console.warn("[Searcher] FTS index missing, attempting to create...");
        try {
          await this.db.createFTSIndex();
          let ftsQuery = table.search(query).limit(PRE_RERANK_K);
          if (whereClause) {
            ftsQuery = ftsQuery.where(whereClause);
          }
          ftsResults = (await ftsQuery.toArray()) as VectorRecord[];
        } catch (retryErr) {
          console.warn("[Searcher] FTS self-heal failed:", retryErr);
        }
      } else {
        // ignore other fts failures
      }
    }

    // Reciprocal Rank Fusion (vector + FTS)
    const RRF_K = 60;
    const candidateScores = new Map<string, number>();
    const docMap = new Map<string, VectorRecord>();

    vectorResults.forEach((doc, rank) => {
      const key = `${doc.path}:${doc.chunk_index}`;
      docMap.set(key, doc);
      const score = 1.0 / (RRF_K + rank + 1);
      candidateScores.set(key, (candidateScores.get(key) || 0) + score);
    });

    ftsResults.forEach((doc, rank) => {
      const key = `${doc.path}:${doc.chunk_index}`;
      if (!docMap.has(key)) docMap.set(key, doc);
      const score = 1.0 / (RRF_K + rank + 1);
      candidateScores.set(key, (candidateScores.get(key) || 0) + score);
    });

    const fused = Array.from(candidateScores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => docMap.get(key))
      .filter(Boolean) as VectorRecord[];

    // Item 8: Widen PRE_RERANK_K
    // Retrieve a wide set for Stage 1 filtering
    const STAGE1_K = 1000;
    const topCandidates = fused.slice(0, STAGE1_K);

    // Item 9: Two-stage rerank
    // Stage 1: Cheap pooled cosine filter
    let stage2Candidates = topCandidates;
    if (queryPooled && topCandidates.length > 200) {
      const cosineScores = topCandidates.map((doc) => {
        if (!doc.pooled_colbert_48d) return -1;
        // Manual cosine sim since we don't have helper here easily
        // Assuming vectors are normalized (which they should be from orchestrator)
        let dot = 0;
        const docVec = doc.pooled_colbert_48d;
        for (let i = 0; i < queryPooled.length; i++) {
          dot += queryPooled[i] * (docVec[i] || 0);
        }
        return dot;
      });

      // Sort by cosine score and keep top 200
      const withScore = topCandidates.map((doc, i) => ({
        doc,
        score: cosineScores[i],
      }));
      withScore.sort((a, b) => b.score - a.score);
      stage2Candidates = withScore.slice(0, 200).map((x) => x.doc);
    }

    if (stage2Candidates.length === 0) {
      return { data: [] };
    }

    const scores = await pool.rerank({
      query: queryMatrixRaw,
      docs: stage2Candidates.map((doc) => ({
        colbert: (doc.colbert as Buffer | Int8Array | number[]) ?? [],
        scale: typeof doc.colbert_scale === "number" ? doc.colbert_scale : 1,
        token_ids: Array.isArray((doc as any).doc_token_ids)
          ? ((doc as any).doc_token_ids as number[])
          : undefined,
      })),
      colbertDim,
    });

    const scored = stage2Candidates.map((doc, idx) => ({
      record: doc,
      score: scores?.[idx] ?? 0,
    }));

    const boosted = scored.map((item) => {
      const boost = this.applyStructureBoost(item.record, item.score);
      return { ...item, score: boost };
    });

    boosted.sort((a, b) => b.score - a.score);

    // Item 10: Per-file diversification
    const seenFiles = new Map<string, number>();
    const diversified: typeof boosted = [];
    const MAX_PER_FILE = 3;

    for (const item of boosted) {
      const path = item.record.path || "";
      const count = seenFiles.get(path) || 0;
      if (count < MAX_PER_FILE) {
        diversified.push(item);
        seenFiles.set(path, count + 1);
      }
      if (diversified.length >= finalLimit) break;
    }

    const finalResults = diversified.map((item) => ({
      ...item.record,
      _score: item.score,
      vector: undefined,
      colbert: undefined,
    }));

    return {
      data: finalResults.map((r) => this.mapRecordToChunk(r, r._score || 0)),
    };
  }
}
