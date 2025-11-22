import { LocalStore } from "./lib/local-store";

type EvalCase = {
  query: string;
  expectedPath: string;
  avoidPath?: string; // <--- New field: If this ranks HIGHER than expected, it's a fail.
  note?: string;
};

const cases: EvalCase[] = [
  {
    query: "Where do we compute reranker scores?",
    expectedPath: "src/lib/local-store.ts",
    note: "Rerank integration and scoring blend.",
  },
  {
    query: "Which model generates embeddings?",
    expectedPath: "src/lib/worker.ts",
    note: "Embedding worker pipeline selection.",
  },
  {
    query: "How are code chunks built with comments?",
    expectedPath: "src/lib/chunker.ts",
    note: "Comment-aware chunker and splitting.",
  },
  {
    query: "What limits sync concurrency?",
    expectedPath: "src/utils.ts",
    note: "p-limit cap in sync/indexing logic.",
  },
  {
    query: "How is the LanceDB vector index created?",
    expectedPath: "src/lib/local-store.ts",
    note: "Vector index configuration.",
  },
  {
    query: "prevent the background process from crashing the computer",
    expectedPath: "src/lib/local-store.ts",
    note: "MAX_WORKER_RSS guard and restart.",
  },
  {
    query: "turn the text into numbers",
    expectedPath: "src/lib/worker.ts",
    note: "Embedding function logic.",
  },
  {
    query: "cleanup zombie files",
    expectedPath: "src/utils.ts",
    note: "Pruning/cleanup logic during sync.",
  },
  {
    query: "search command implementation",
    expectedPath: "src/commands/search.ts",
    avoidPath: "src/index.ts",
    note: "CLI search command body.",
  },
  {
    query: "cli entry point",
    expectedPath: "src/index.ts",
    note: "Program startup and command wiring.",
  },
  {
    query: "lancedb setup",
    expectedPath: "src/lib/local-store.ts",
    note: "DB path and table creation.",
  },
  {
    query: "worker thread management",
    expectedPath: "src/lib/local-store.ts",
    note: "Worker init/restart and messaging.",
  },
  {
    query: "chunking logic",
    expectedPath: "src/lib/chunker.ts",
    note: "Tree-sitter traversal and slicing.",
  },
  { query: "MAX_WORKER_RSS", expectedPath: "src/lib/local-store.ts" },
  { query: "createVectorIndex", expectedPath: "src/lib/local-store.ts" },
  { query: "createFTSIndex", expectedPath: "src/lib/local-store.ts" },
  {
    query: "Represent this sentence for searching relevant passages",
    expectedPath: "src/lib/local-store.ts",
    note: "Query prefix for embeddings.",
  },
  { query: "GRAMMARS_DIR", expectedPath: "src/lib/chunker.ts" },
  { query: "OVERLAP_LINES", expectedPath: "src/lib/chunker.ts" },
  { query: "VECTOR_DIMENSIONS", expectedPath: "src/lib/local-store.ts" },
  {
    query: "download tree-sitter grammars",
    expectedPath: "src/lib/chunker.ts",
    note: "Grammar fetch and WASM loading.",
  },
  {
    query: "restart worker when memory is high",
    expectedPath: "src/lib/local-store.ts",
    note: "RSS guard and worker restart logic.",
  },
  {
    query: "serialize embedding requests",
    expectedPath: "src/lib/local-store.ts",
    note: "embedQueue / enqueueEmbedding.",
  },
  {
    query: "path filter starts_with for search",
    expectedPath: "src/lib/local-store.ts",
    note: "Path filtering in search filters.",
  },
  {
    query: "RRF fusion",
    expectedPath: "src/lib/local-store.ts",
    note: "Vector + FTS combination.",
  },
  {
    query: "reranker fallback",
    expectedPath: "src/lib/local-store.ts",
    note: "Graceful fallback when rerank fails.",
  },
  {
    query: "model cache directory",
    expectedPath: "src/lib/worker.ts",
    note: "CACHE_DIR for transformers.",
  },
  {
    query: "LanceDB table schema",
    expectedPath: "src/lib/local-store.ts",
    note: "Base schema row with seed data.",
  },
  {
    query: "gitignore caching",
    expectedPath: "src/lib/git.ts",
    note: "GitIgnoreFilter memoization.",
  },
  {
    query: "osgrepignore support",
    expectedPath: "src/lib/file.ts",
    note: "Custom ignore patterns.",
  },
  {
    query: "list files using git ls-files",
    expectedPath: "src/lib/git.ts",
    note: "NodeGit getGitFiles implementation.",
  },
  {
    query: "hidden file handling",
    expectedPath: "src/lib/file.ts",
    note: "isHiddenFile logic.",
  },
  {
    query: "file hash computation",
    expectedPath: "src/utils.ts",
    note: "computeFileHash and buffer hashing.",
  },
  {
    query: "initial sync spinner text",
    expectedPath: "src/lib/sync-helpers.ts",
    note: "createIndexingSpinner formatting.",
  },
  {
    query: "dry run summary message",
    expectedPath: "src/lib/sync-helpers.ts",
    note: "formatDryRunSummary phrasing.",
  },
  {
    query: "skip empty files during indexing",
    expectedPath: "src/utils.ts",
    note: "Zero-byte guard before indexing.",
  },
  {
    query: "MetaStore caching hashes",
    expectedPath: "src/utils.ts",
    note: "Skip unchanged files using meta.json.",
  },
  {
    query: "index command workflow",
    expectedPath: "src/commands/index.ts",
    note: "Full indexing path and wait loop.",
  },
  {
    query: "doctor command health checks",
    expectedPath: "src/commands/doctor.ts",
    note: "Reports model/data/grammar paths.",
  },
  {
    query: "quantized models for embeddings",
    expectedPath: "src/lib/worker.ts",
    note: "q8 settings for pipelines.",
  },
  {
    query: "text-classification reranker",
    expectedPath: "src/lib/worker.ts",
    note: "Rerank pipeline setup.",
  },
  {
    query: "normalize embeddings",
    expectedPath: "src/lib/worker.ts",
    note: "Normalization in embed() call.",
  },
  {
    query: "chunk splitting into overlapping windows",
    expectedPath: "src/lib/chunker.ts",
    note: "Sliding window splitIfTooBig.",
  },
  {
    query: "fallback chunking when parser fails",
    expectedPath: "src/lib/chunker.ts",
    note: "fallbackChunk logic.",
  },
  {
    query: "grammar download directory",
    expectedPath: "src/lib/chunker.ts",
    note: ".osgrep/grammars path handling.",
  },
  {
    query: "vector + keyword fusion candidates",
    expectedPath: "src/lib/local-store.ts",
    note: "candidateLimit and fusion scoring.",
  },
  {
    query: "database path for embeddings",
    expectedPath: "src/lib/local-store.ts",
    note: ".osgrep/data DB_PATH.",
  },
  {
    query: "rerank score blending",
    expectedPath: "src/lib/local-store.ts",
    note: "0.7 rerank + 0.3 RRF fusion.",
  },
];

const storeId = process.argv[2] ?? "default";
const topK = 20;

async function run() {
  const store = new LocalStore();
  const results: {
    rr: number;
    found: boolean;
    recall: number;
    path: string;
    query: string;
    note?: string;
    timeMs: number;
  }[] = [];

  console.log("Starting evaluation...\n");
  const startTime = performance.now();

  for (const c of cases) {
    const queryStart = performance.now();
    const res = await store.search(storeId, c.query, topK);
    const queryEnd = performance.now();
    const timeMs = queryEnd - queryStart;

    const rank = res.data.findIndex((chunk) =>
      chunk.metadata?.path
        ?.toLowerCase()
        .includes(c.expectedPath.toLowerCase()),
    );
    const rr = rank >= 0 ? 1 / (rank + 1) : 0;
    const recall = rank >= 0 && rank < 10 ? 1 : 0;
    results.push({
      rr,
      found: rank >= 0,
      recall,
      path: c.expectedPath,
      query: c.query,
      note: c.note,
      timeMs,
    });
  }

  const totalTime = performance.now() - startTime;
  const mrr = results.reduce((sum, r) => sum + r.rr, 0) / results.length;
  const recallAt10 =
    results.reduce((sum, r) => sum + r.recall, 0) / results.length;
  const avgTime =
    results.reduce((sum, r) => sum + r.timeMs, 0) / results.length;

  console.log("=".repeat(80));
  console.log(`Eval results for store: ${storeId}`);
  console.log("=".repeat(80));
  results.forEach((r) => {
    const status = r.found ? `rank ${(1 / r.rr).toFixed(0)}` : "❌ missed";
    const emoji = r.found ? (r.rr === 1 ? "🎯" : "✓") : "❌";
    console.log(`${emoji} ${r.query}`);
    console.log(
      `   => ${status} (target: ${r.path}) [${r.timeMs.toFixed(0)}ms]`,
    );
    if (r.note) {
      console.log(`   // ${r.note}`);
    }
  });
  console.log("=".repeat(80));
  console.log(`MRR: ${mrr.toFixed(3)}`);
  console.log(`Recall@10: ${recallAt10.toFixed(3)}`);
  console.log(`Avg query time: ${avgTime.toFixed(0)}ms`);
  console.log(`Total time: ${totalTime.toFixed(0)}ms`);
  console.log(
    `Found: ${results.filter((r) => r.found).length}/${results.length}`,
  );
  console.log("=".repeat(80));
}

run().catch((err) => {
  console.error("Eval failed:", err);
  process.exitCode = 1;
});
