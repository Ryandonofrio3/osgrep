import { describe, expect, it, vi } from "vitest";
import type { SearchResponse } from "../src/lib/store";
import { LocalStore } from "../src/lib/local-store";

type FakeTableRecord = {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
  hash?: string;
  chunk_index?: number;
  is_anchor?: boolean;
};

function buildTable({
  vectorResults,
  ftsResults,
  rowCount = 500,
}: {
  vectorResults: FakeTableRecord[];
  ftsResults?: FakeTableRecord[];
  rowCount?: number;
}) {
  const whereClauses: string[] = [];
  const table = {
    countRows: vi.fn(async () => rowCount),
    search: vi.fn((query: unknown) => {
      let filterClause: string | null = null;
      const resultSet =
        typeof query === "string" ? ftsResults ?? [] : vectorResults;
      const queryWrapper: any = {
        limit: vi.fn(() => queryWrapper),
        where: vi.fn((clause: string) => {
          whereClauses.push(clause);
          filterClause = clause;
          return queryWrapper;
        }),
        toArray: async () => {
          if (!filterClause) return resultSet;
          const match = /path\s+like\s+'(.+)%'/i.exec(filterClause);
          const prefix = match?.[1] ?? "";
          return resultSet.filter((r) => (r.path ?? "").startsWith(prefix));
        },
      };
      return queryWrapper;
    }),
  };
  return Object.assign(table, { lastWhereClauses: whereClauses });
}

async function runSearchWithFakeStore({
  table,
  rerankScores,
  filters,
  topK,
  rerankError = false,
}: {
  table: ReturnType<typeof buildTable>;
  rerankScores: number[];
  filters?: Record<string, unknown>;
  topK?: number;
  rerankError?: boolean;
}): Promise<SearchResponse> {
  const fakeStore: any = {
    queryPrefix: "prefix ",
    getTable: vi.fn(async () => table),
    workerManager: {
      getEmbedding: vi.fn(async () => [0]),
      rerank: rerankError
        ? vi.fn(async () => {
            throw new Error("rerank failed");
          })
        : vi.fn(async () => rerankScores),
    },
    batchExpandWithNeighbors: vi.fn(async (_table, records) => records),
  };

  const searchFn = LocalStore.prototype.search;
  return await searchFn.call(
    fakeStore,
    "store",
    "query",
    topK,
    { rerank: true },
    filters as any,
  );
}

// Unit-level fusion test: uses fake tables to exercise scoring without LanceDB
describe("LocalStore.search fusion (unit)", () => {
  it("orders by blended rerank scores when available", async () => {
    const table = buildTable({
      vectorResults: [
        {
          path: "/repo/match.ts",
          start_line: 0,
          end_line: 1,
          content: "vector match",
          hash: "h1",
        },
        {
          path: "/repo/secondary.ts",
          start_line: 0,
          end_line: 1,
          content: "vector secondary",
          hash: "h2",
        },
      ],
    });

    const res = await runSearchWithFakeStore({
      table,
      rerankScores: [0.9, 0.1],
      topK: 1,
    });

    expect(res.data[0]?.metadata?.path).toBe("/repo/match.ts");
  });

  it("falls back to RRF order when reranker fails", async () => {
    const table = buildTable({
      vectorResults: [
        {
          path: "/repo/vector.ts",
          start_line: 0,
          end_line: 1,
          content: "vector",
          hash: "h1",
        },
      ],
      ftsResults: [
        {
          path: "/repo/fts.ts",
          start_line: 0,
          end_line: 1,
          content: "fts",
          hash: "h2",
        },
      ],
    });

    const res = await runSearchWithFakeStore({
      table,
      rerankScores: [],
      rerankError: true,
    });

    const paths = res.data.map((c) => c.metadata?.path);
    expect(paths).toContain("/repo/vector.ts");
  });

  it("applies path filters before fusion", async () => {
    const table = buildTable({
      vectorResults: [
        {
          path: "/repo/include/file.ts",
          start_line: 0,
          end_line: 1,
          content: "keep me",
          hash: "h1",
        },
        {
          path: "/repo/exclude/file.ts",
          start_line: 0,
          end_line: 1,
          content: "drop me",
          hash: "h2",
        },
      ],
      ftsResults: [],
    });

    const res = await runSearchWithFakeStore({
      table,
      rerankScores: [0.5, 0.4],
      filters: {
        all: [
          {
            key: "path",
            operator: "starts_with",
            value: "/repo/include",
          },
        ],
      },
    });

    const whereClauses = (table as any).lastWhereClauses as string[];
    expect(whereClauses.some((c) => c.includes("/repo/include"))).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]?.metadata?.path).toBe("/repo/include/file.ts");
  });
});
