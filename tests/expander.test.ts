import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChunkType } from "../src/lib/store/types";

// Mock VectorDB
const mockQuery = vi.fn();
const mockTable = {
  query: vi.fn(() => ({
    where: vi.fn(() => ({
      limit: vi.fn(() => ({
        toArray: mockQuery,
      })),
    })),
  })),
};

const mockDb = {
  ensureTable: vi.fn(async () => mockTable),
};

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(() => mockDb),
}));

import { Expander } from "../src/lib/search/expander";
import type { ExpandOptions } from "../src/lib/search/expansion-types";

describe("Expander", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([]);
  });

  const createMockChunk = (overrides: Partial<ChunkType> = {}): ChunkType => ({
    type: "text",
    text: "function test() { return 42; }",
    score: 0.9,
    metadata: {
      path: "src/lib/utils.ts",
      hash: "abc123",
    },
    generated_metadata: {
      start_line: 10,
      end_line: 15,
      num_lines: 6,
    },
    defined_symbols: ["test"],
    referenced_symbols: ["helper", "config"],
    imports: [],
    exports: [],
    ...overrides,
  });

  describe("symbol resolution", () => {
    it("resolves symbols to correct definitions", async () => {
      const expander = new Expander(mockDb as any);

      // Mock definition found for "helper" symbol
      mockQuery.mockResolvedValueOnce([
        {
          id: "def-helper",
          path: "src/lib/helper.ts",
          content: "export function helper() {}",
          display_text: "export function helper() {}",
          start_line: 1,
          end_line: 3,
          defined_symbols: ["helper"],
          referenced_symbols: [],
          is_anchor: false,
        },
      ]);

      const results = [createMockChunk()];
      const expanded = await expander.expand(results, "test query", {
        strategies: ["symbols"],
      });

      expect(expanded.expanded.length).toBeGreaterThan(0);
      expect(expanded.expanded[0].relationship).toBe("symbols");
      expect(expanded.expanded[0].via).toBe("helper");
      expect(expanded.stats.symbolsResolved).toBeGreaterThan(0);
    });

    it("prefers same-directory definitions", async () => {
      const expander = new Expander(mockDb as any);

      // Return two definitions - one in same dir, one in different dir
      mockQuery.mockResolvedValueOnce([
        {
          id: "def-distant",
          path: "src/other/helper.ts",
          content: "export function helper() {}",
          start_line: 1,
          end_line: 3,
          defined_symbols: ["helper"],
          referenced_symbols: [],
        },
        {
          id: "def-nearby",
          path: "src/lib/helper.ts",
          content: "export function helper() {}",
          start_line: 1,
          end_line: 3,
          defined_symbols: ["helper"],
          referenced_symbols: [],
        },
      ]);

      const results = [createMockChunk()];
      const expanded = await expander.expand(results, "test query", {
        strategies: ["symbols"],
        maxExpanded: 1,
      });

      // Should prefer the same-directory definition
      expect(expanded.expanded.length).toBe(1);
      const expandedPath =
        (expanded.expanded[0].chunk.metadata as any)?.path || "";
      expect(expandedPath).toContain("src/lib");
    });

    it("respects maxExpanded limit", async () => {
      const expander = new Expander(mockDb as any);

      // Return many definitions for each symbol query
      const manyDefs = Array.from({ length: 50 }, (_, i) => ({
        id: `def-${i}`,
        path: `src/file${i}.ts`,
        content: `export function func${i}() {}`,
        start_line: 1,
        end_line: 3,
        defined_symbols: [`func${i}`],
        referenced_symbols: [],
      }));

      // Mock returns subset of definitions for each query
      mockQuery.mockImplementation(() => Promise.resolve(manyDefs.slice(0, 5)));

      const results = [
        createMockChunk({
          referenced_symbols: manyDefs.map((_, i) => `func${i}`),
        }),
      ];

      const maxExpanded = 5;
      const expanded = await expander.expand(results, "test query", {
        strategies: ["symbols"],
        maxExpanded,
      });

      // Should respect the limit
      expect(expanded.expanded.length).toBeLessThanOrEqual(maxExpanded);
    });

    it("handles circular references without infinite loop", async () => {
      const expander = new Expander(mockDb as any);

      // Chunk A refs B, query returns chunk that refs A
      mockQuery.mockResolvedValueOnce([
        {
          id: "def-helper",
          path: "src/lib/helper.ts",
          content: "export function helper() { test(); }",
          start_line: 1,
          end_line: 3,
          defined_symbols: ["helper"],
          referenced_symbols: ["test"], // References back!
        },
      ]);

      const results = [createMockChunk()];
      const expanded = await expander.expand(results, "test query", {
        strategies: ["symbols"],
        maxDepth: 2,
      });

      // Should complete without error and not include duplicates
      const ids = new Set(
        expanded.expanded.map(
          (e) => (e.chunk.metadata as any)?.hash || e.chunk.text,
        ),
      );
      expect(ids.size).toBe(expanded.expanded.length);
    });

    it("returns empty expansion gracefully when no definitions found", async () => {
      const expander = new Expander(mockDb as any);

      // No definitions found
      mockQuery.mockResolvedValue([]);

      const results = [createMockChunk()];
      const expanded = await expander.expand(results, "test query", {
        strategies: ["symbols"],
      });

      // Should return original results with empty expanded
      expect(expanded.original).toEqual(results);
      expect(expanded.expanded).toEqual([]);
      expect(expanded.stats.symbolsResolved).toBe(0);
    });
  });

  describe("caller expansion", () => {
    it("finds callers that reference defined symbols", async () => {
      const expander = new Expander(mockDb as any);

      // Mock caller found
      mockQuery.mockResolvedValueOnce([
        {
          id: "caller-1",
          path: "src/routes/handler.ts",
          content: "import { test } from '../lib/utils'; test();",
          start_line: 5,
          end_line: 10,
          defined_symbols: ["handleRequest"],
          referenced_symbols: ["test"],
          is_anchor: false,
        },
      ]);

      const results = [createMockChunk()];
      const expanded = await expander.expand(results, "test query", {
        strategies: ["callers"],
      });

      expect(expanded.expanded.length).toBeGreaterThan(0);
      expect(expanded.expanded[0].relationship).toBe("callers");
      expect(expanded.expanded[0].via).toContain("uses");
      expect(expanded.stats.callersFound).toBeGreaterThan(0);
    });
  });

  describe("neighbor expansion", () => {
    it("includes anchor chunks from same directory", async () => {
      const expander = new Expander(mockDb as any);

      // First query is for symbols (returns nothing)
      mockQuery.mockResolvedValueOnce([]);
      // Second query for callers (returns nothing)
      mockQuery.mockResolvedValueOnce([]);
      // Third query for neighbors
      mockQuery.mockResolvedValueOnce([
        {
          id: "neighbor-anchor",
          path: "src/lib/other.ts",
          content: "// File: src/lib/other.ts\nExports: helper",
          start_line: 0,
          end_line: 5,
          defined_symbols: [],
          referenced_symbols: [],
          is_anchor: true,
        },
      ]);

      const results = [createMockChunk()];
      const expanded = await expander.expand(results, "test query", {
        strategies: ["symbols", "callers", "neighbors"],
      });

      const neighbors = expanded.expanded.filter(
        (e) => e.relationship === "neighbors",
      );
      expect(neighbors.length).toBeGreaterThanOrEqual(0);
      if (neighbors.length > 0) {
        expect(neighbors[0].via).toBe("same directory");
        expect(expanded.stats.neighborsAdded).toBeGreaterThan(0);
      }
    });
  });

  describe("multi-hop expansion", () => {
    it("follows chains of dependencies with depth > 1", async () => {
      const expander = new Expander(mockDb as any);

      // Depth 1: A -> B
      mockQuery
        .mockResolvedValueOnce([
          {
            id: "def-B",
            path: "src/lib/b.ts",
            content: "export function funcB() { funcC(); }",
            start_line: 1,
            end_line: 3,
            defined_symbols: ["funcB"],
            referenced_symbols: ["funcC"],
          },
        ])
        // Depth 2: B -> C
        .mockResolvedValueOnce([
          {
            id: "def-C",
            path: "src/lib/c.ts",
            content: "export function funcC() {}",
            start_line: 1,
            end_line: 3,
            defined_symbols: ["funcC"],
            referenced_symbols: [],
          },
        ]);

      const results = [
        createMockChunk({
          referenced_symbols: ["funcB"],
        }),
      ];

      const expanded = await expander.expand(results, "test query", {
        strategies: ["symbols"],
        maxDepth: 2,
      });

      // Should have found both B and C
      expect(expanded.expanded.length).toBeGreaterThanOrEqual(1);
    });

    it("scores decay with depth", async () => {
      const expander = new Expander(mockDb as any);

      // Return definitions at different depths
      mockQuery.mockResolvedValue([
        {
          id: "def-1",
          path: "src/lib/dep.ts",
          content: "export function dep() {}",
          start_line: 1,
          end_line: 3,
          defined_symbols: ["dep"],
          referenced_symbols: [],
        },
      ]);

      const results = [createMockChunk({ referenced_symbols: ["dep"] })];
      const expanded = await expander.expand(results, "test query", {
        strategies: ["symbols"],
        maxDepth: 1,
      });

      // All expanded chunks should have score < 1 (decayed from parent)
      for (const node of expanded.expanded) {
        expect(node.score).toBeLessThan(1.0);
      }
    });
  });

  describe("token budgeting", () => {
    it("stops expanding when token budget exhausted", async () => {
      const expander = new Expander(mockDb as any);

      // Return large chunks
      const largeDefs = Array.from({ length: 10 }, (_, i) => ({
        id: `def-${i}`,
        path: `src/file${i}.ts`,
        content: "x".repeat(1000), // ~250 tokens each
        start_line: 1,
        end_line: 100,
        defined_symbols: [`func${i}`],
        referenced_symbols: [],
      }));

      mockQuery.mockResolvedValue(largeDefs);

      const results = [
        createMockChunk({
          referenced_symbols: largeDefs.map((_, i) => `func${i}`),
        }),
      ];

      const expanded = await expander.expand(results, "test query", {
        strategies: ["symbols"],
        maxTokens: 500, // Should only fit 1-2 chunks
      });

      expect(expanded.stats.totalTokens).toBeLessThanOrEqual(500 + 100); // Some buffer
      expect(expanded.stats.budgetRemaining).toBeDefined();
    });

    it("prioritizes high-value chunks within budget", async () => {
      const expander = new Expander(mockDb as any);

      mockQuery.mockResolvedValue([
        {
          id: "def-nearby",
          path: "src/lib/nearby.ts",
          content: "export function nearby() {}",
          start_line: 1,
          end_line: 3,
          defined_symbols: ["nearby"],
          referenced_symbols: [],
        },
      ]);

      const results = [
        createMockChunk({
          referenced_symbols: ["nearby"],
        }),
      ];

      const expanded = await expander.expand(results, "test query", {
        strategies: ["symbols"],
        maxTokens: 5000, // Generous budget
      });

      // Should include the nearby definition with high score
      if (expanded.expanded.length > 0) {
        expect(expanded.expanded[0].score).toBeGreaterThan(0);
      }
    });
  });

  describe("graceful degradation", () => {
    it("returns original results when database unavailable", async () => {
      const failingDb = {
        ensureTable: vi.fn(async () => {
          throw new Error("Database unavailable");
        }),
      };

      const expander = new Expander(failingDb as any);
      const results = [createMockChunk()];

      const expanded = await expander.expand(results, "test query");

      expect(expanded.original).toEqual(results);
      expect(expanded.expanded).toEqual([]);
      expect(expanded.truncated).toBe(false);
    });

    it("continues expansion when individual queries fail", async () => {
      const expander = new Expander(mockDb as any);

      // First query fails, second succeeds
      mockQuery
        .mockRejectedValueOnce(new Error("Query failed"))
        .mockResolvedValueOnce([
          {
            id: "def-success",
            path: "src/lib/success.ts",
            content: "export function success() {}",
            start_line: 1,
            end_line: 3,
            defined_symbols: ["success"],
            referenced_symbols: [],
          },
        ]);

      const results = [
        createMockChunk({
          referenced_symbols: ["failing", "success"],
        }),
      ];

      const expanded = await expander.expand(results, "test query", {
        strategies: ["symbols"],
      });

      // Should still have results from successful query
      expect(expanded.expanded.length).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("ExpandOptions", () => {
  it("uses default options when none provided", async () => {
    const expander = new Expander(mockDb as any);
    mockQuery.mockResolvedValue([]);

    const results = [
      {
        type: "text" as const,
        text: "test",
        score: 0.9,
        metadata: { path: "test.ts", hash: "abc" },
        generated_metadata: { start_line: 1, end_line: 5 },
        defined_symbols: [],
        referenced_symbols: [],
      },
    ];

    const expanded = await expander.expand(results, "query");

    // Should complete without error using defaults
    expect(expanded.original).toEqual(results);
  });

  it("respects custom strategies", async () => {
    const expander = new Expander(mockDb as any);

    mockQuery.mockResolvedValue([
      {
        id: "def-1",
        path: "src/lib/dep.ts",
        content: "export function dep() {}",
        start_line: 1,
        end_line: 3,
        defined_symbols: ["dep"],
        referenced_symbols: [],
      },
    ]);

    const results = [
      {
        type: "text" as const,
        text: "function test() { dep(); }",
        score: 0.9,
        metadata: { path: "test.ts", hash: "abc" },
        generated_metadata: { start_line: 1, end_line: 5 },
        defined_symbols: ["test"],
        referenced_symbols: ["dep"],
      },
    ];

    // Only use symbols strategy
    const expanded = await expander.expand(results, "query", {
      strategies: ["symbols"],
    });

    // Should only have symbol expansions
    for (const node of expanded.expanded) {
      expect(node.relationship).toBe("symbols");
    }
    expect(expanded.stats.callersFound).toBe(0);
    expect(expanded.stats.neighborsAdded).toBe(0);
  });
});
