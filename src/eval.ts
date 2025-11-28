// Reduce worker pool fan-out during eval to avoid ONNX concurrency issues
process.env.OSGREP_WORKER_COUNT ??= "1";

import { LocalStore } from "./lib/local-store";

import type { SearchResponse } from "./lib/store";

export type EvalCase = {
  query: string;
  expectedPath: string;
  avoidPath?: string; // <--- New field: If this ranks HIGHER than expected, it's a fail.
  note?: string;
};

export type EvalResult = {
  rr: number;
  found: boolean;
  recall: number;
  path: string;
  query: string;
  note?: string;
  timeMs: number;
};

export const cases: EvalCase[] = [
  // --- Core Architecture & Data Flow ---
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
    query: "How is the LanceDB vector index created?",
    expectedPath: "src/lib/local-store.ts",
    note: "Vector index configuration.",
  },
  {
    query: "turn the text into numbers",
    expectedPath: "src/lib/worker.ts",
    note: "Embedding function logic.",
  },
  {
    query: "lancedb setup",
    expectedPath: "src/lib/local-store.ts",
    note: "DB path and table creation.",
  },
  {
    query: "worker thread management",
    expectedPath: "src/lib/local-store.ts|src/lib/worker-manager.ts",
    note: "Worker init/restart and messaging.",
  },
  { query: "createVectorIndex", expectedPath: "src/lib/local-store.ts" },
  { query: "createFTSIndex", expectedPath: "src/lib/local-store.ts" },
  {
    query: "Represent this sentence for searching relevant passages",
    expectedPath: "src/lib/local-store.ts",
    note: "Query prefix for embeddings.",
  },
  { query: "VECTOR_DIMENSIONS", expectedPath: "src/lib/local-store.ts" },
  {
    query: "restart worker when memory is high",
    expectedPath: "src/lib/local-store.ts|src/lib/worker-manager.ts",
    note: "Worker resilience and restart logic.",
  },
  {
    query: "serialize embedding requests",
    expectedPath: "src/lib/local-store.ts|src/lib/worker-manager.ts",
    note: "embedQueue / enqueueEmbedding.",
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
  {
    query: "onnx runtime threading",
    expectedPath: "src/lib/worker.ts",
    note: "ONNX backend configuration.",
  },
  {
    query: "worker message handling",
    expectedPath: "src/lib/worker.ts",
    note: "Parent port message listener.",
  },
  {
    query: "colbert stride logic",
    expectedPath: "src/lib/local-store.ts",
    note: "ColBERT matrix stride calculation.",
  },
  {
    query: "structural boosting",
    expectedPath: "src/lib/local-store.ts",
    note: "applyStructureBoost function.",
  },
  {
    query: "hybrid search implementation",
    expectedPath: "src/lib/local-store.ts",
    note: "The main search method logic.",
  },
  {
    query: "maxSim scoring function",
    expectedPath: "src/lib/colbert-math.ts|src/lib/local-store.ts",
    note: "ColBERT scoring math.",
  },
  {
    query: "worker shutdown",
    expectedPath: "src/lib/worker-manager.ts",
    note: "terminate() and cleanup.",
  },
  {
    query: "embedding batch processing",
    expectedPath: "src/lib/worker.ts",
    note: "Batch handling in worker.",
  },

  // --- Indexing & Chunking ---
  {
    query: "How are code chunks built with comments?",
    expectedPath: "src/lib/chunker.ts",
    note: "Comment-aware chunker and splitting.",
  },
  {
    query: "chunking logic",
    expectedPath: "src/lib/chunker.ts",
    note: "Tree-sitter traversal and slicing.",
  },
  { query: "GRAMMARS_DIR", expectedPath: "src/lib/chunker.ts" },
  { query: "OVERLAP_LINES", expectedPath: "src/lib/chunker.ts" },
  {
    query: "download tree-sitter grammars",
    expectedPath: "src/lib/chunker.ts|src/lib/grammar-loader.ts",
    note: "Grammar fetch and WASM loading.",
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
    query: "anchor chunk creation",
    expectedPath: "src/lib/chunk-utils.ts",
    note: "buildAnchorChunk function.",
  },
  {
    query: "formatting chunk text",
    expectedPath: "src/lib/chunk-utils.ts",
    note: "formatChunkText function.",
  },
  {
    query: "tree-sitter language loading",
    expectedPath: "src/lib/chunker.ts",
    note: "Loading WASM languages.",
  },
  {
    query: "max lines per chunk",
    expectedPath: "src/lib/chunker.ts",
    note: "MAX_LINES constant.",
  },
  {
    query: "deduplicate identical chunks",
    expectedPath: "src/lib/local-store.ts",
    note: "Deduplication logic during indexing.",
  },
  {
    query: "indexing profile stats",
    expectedPath: "src/lib/local-store.ts",
    note: "LocalStoreProfile interface.",
  },
  {
    query: "handling large files during indexing",
    expectedPath: "src/lib/chunker.ts",
    note: "Splitting large files.",
  },
  {
    query: "context window for chunks",
    expectedPath: "src/lib/chunker.ts|src/lib/local-store.ts",
    note: "Context prev/next fields.",
  },
  {
    query: "supported languages for chunking",
    expectedPath: "src/lib/chunker.ts",
    note: "List of supported extensions.",
  },
  {
    query: "chunk type detection",
    expectedPath: "src/lib/chunker.ts",
    note: "Identifying function/class/etc.",
  },
  {
    query: "min chunk size",
    expectedPath: "src/lib/chunker.ts",
    note: "Minimum lines for a chunk.",
  },
  {
    query: "loading wasm files",
    expectedPath: "src/lib/chunker.ts",
    note: "fs.readFile for wasm.",
  },

  // --- CLI Commands & Entry Points ---
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
    query: "serve command implementation",
    expectedPath: "src/commands/serve.ts",
    note: "Server daemon logic.",
  },
  {
    query: "list command implementation",
    expectedPath: "src/commands/list.ts",
    note: "Listing stores.",
  },
  {
    query: "setup command logic",
    expectedPath: "src/commands/setup.ts",
    note: "Initial setup and download.",
  },
  {
    query: "search command flags",
    expectedPath: "src/commands/search.ts",
    note: "Options like --json, --compact.",
  },
  {
    query: "index command dry run",
    expectedPath: "src/commands/index.ts",
    note: "Dry run flag handling.",
  },
  {
    query: "server health check endpoint",
    expectedPath: "src/commands/serve.ts",
    note: "/health route.",
  },
  {
    query: "server search endpoint",
    expectedPath: "src/commands/serve.ts",
    note: "/search route.",
  },
  {
    query: "claude code integration",
    expectedPath: "src/commands/claude-code.ts",
    note: "Claude code specific logic.",
  },
  {
    query: "cli version display",
    expectedPath: "src/index.ts",
    note: "-v / --version flag.",
  },
  {
    query: "cli help message",
    expectedPath: "src/index.ts",
    note: "-h / --help flag.",
  },
  {
    query: "reset index flag",
    expectedPath: "src/commands/index.ts",
    note: "--reset handling.",
  },
  {
    query: "compact output format",
    expectedPath: "src/commands/search.ts",
    note: "Compact formatting logic.",
  },
  {
    query: "json output format",
    expectedPath: "src/commands/search.ts",
    note: "JSON formatting logic.",
  },
  {
    query: "server port configuration",
    expectedPath: "src/commands/serve.ts",
    note: "OSGREP_PORT env var.",
  },
  {
    query: "server pid file",
    expectedPath: "src/commands/serve.ts",
    note: "Writing server.json.",
  },
  {
    query: "graceful exit",
    expectedPath: "src/lib/exit.ts",
    note: "Exit handler.",
  },

  // --- Configuration & Environment ---
  {
    query: "What limits sync concurrency?",
    expectedPath: "src/utils.ts",
    note: "p-limit cap in sync/indexing logic.",
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
    query: "environment variables config",
    expectedPath: "src/config.ts",
    note: "Central config object.",
  },
  {
    query: "default ignore patterns",
    expectedPath: "src/lib/ignore-patterns.ts",
    note: "DEFAULT_IGNORE_PATTERNS list.",
  },
  {
    query: "thread count configuration",
    expectedPath: "src/lib/worker.ts",
    note: "OSGREP_THREADS handling.",
  },
  {
    query: "low impact mode",
    expectedPath: "src/lib/worker.ts",
    note: "OSGREP_LOW_IMPACT flag.",
  },
  {
    query: "debug models flag",
    expectedPath: "src/lib/worker.ts",
    note: "OSGREP_DEBUG_MODELS.",
  },
  {
    query: "profile enabled flag",
    expectedPath: "src/lib/local-store.ts",
    note: "OSGREP_PROFILE.",
  },
  {
    query: "model ids configuration",
    expectedPath: "src/config.ts",
    note: "MODEL_IDS constant.",
  },
  {
    query: "user home directory",
    expectedPath: "src/lib/worker.ts|src/lib/local-store.ts",
    note: "os.homedir() usage.",
  },
  {
    query: "project root detection",
    expectedPath: "src/lib/worker.ts",
    note: "process.cwd() usage.",
  },
  {
    query: "device selection (cpu/gpu)",
    expectedPath: "src/lib/worker.ts",
    note: "OSGREP_DEVICE.",
  },
  {
    query: "local models directory",
    expectedPath: "src/lib/worker.ts",
    note: "Checking for 'models' dir.",
  },
  {
    query: "huggingface cache dir",
    expectedPath: "src/lib/worker.ts",
    note: "env.cacheDir setting.",
  },

  // --- Utilities & Helpers ---
  {
    query: "cleanup zombie files",
    expectedPath: "src/utils.ts",
    note: "Pruning/cleanup logic during sync.",
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
    query: "store resolver logic",
    expectedPath: "src/lib/store-resolver.ts",
    note: "getAutoStoreId implementation.",
  },
  {
    query: "auto-detect store name",
    expectedPath: "src/lib/store-resolver.ts",
    note: "Naming based on git remote or dir.",
  },
  {
    query: "pretty print bytes",
    expectedPath: "src/commands/list.ts",
    note: "Formatting file sizes.",
  },
  {
    query: "time ago formatter",
    expectedPath: "src/commands/list.ts",
    note: "Formatting dates.",
  },
  {
    query: "uuid generation",
    expectedPath: "src/lib/local-store.ts",
    note: "uuidv4 usage.",
  },
  {
    query: "check if file is binary",
    expectedPath: "src/lib/file.ts",
    note: "isBinaryFile check.",
  },
  {
    query: "read file content",
    expectedPath: "src/lib/local-store.ts",
    note: "fs.readFileSync or stream reading.",
  },
  {
    query: "create directory recursively",
    expectedPath: "src/lib/local-store.ts",
    note: "fs.mkdirSync with recursive.",
  },
  {
    query: "check file existence",
    expectedPath: "src/lib/local-store.ts",
    note: "fs.existsSync.",
  },
  {
    query: "path join usage",
    expectedPath: "src/lib/local-store.ts",
    note: "path.join.",
  },
  {
    query: "performance timing",
    expectedPath: "src/lib/local-store.ts",
    note: "process.hrtime.bigint().",
  },
  {
    query: "console logging wrapper",
    expectedPath: "src/lib/worker.ts",
    note: "log function.",
  },

  // --- Error Handling & Edge Cases ---
  {
    query: "schema mismatch detection",
    expectedPath: "src/lib/local-store.ts",
    note: "Checking vector dimensions.",
  },
  {
    query: "drop table on mismatch",
    expectedPath: "src/lib/local-store.ts",
    note: "Recreating table if schema differs.",
  },
  {
    query: "fts index creation failure",
    expectedPath: "src/lib/local-store.ts",
    note: "Catching FTS creation errors.",
  },
  {
    query: "vector index creation failure",
    expectedPath: "src/lib/local-store.ts",
    note: "Catching vector index errors.",
  },
  {
    query: "worker error propagation",
    expectedPath: "src/lib/worker-manager.ts",
    note: "Passing errors from worker to main.",
  },
  {
    query: "handle missing store",
    expectedPath: "src/lib/local-store.ts",
    note: "Error when store doesn't exist.",
  },
  {
    query: "handle empty store",
    expectedPath: "src/eval.ts",
    note: "Check in eval script.",
  },
  {
    query: "invalid colbert dimensions",
    expectedPath: "src/lib/worker.ts",
    note: "Throwing error on bad dims.",
  },
  {
    query: "fallback to cpu",
    expectedPath: "src/lib/worker.ts",
    note: "Retry with CPU if device fails.",
  },
  {
    query: "download model retry",
    expectedPath: "src/lib/worker.ts",
    note: "Retrying model download.",
  },
  {
    query: "unknown message type in worker",
    expectedPath: "src/lib/worker.ts",
    note: "Throwing error for unknown msg.",
  },
  {
    query: "handle symlinks",
    expectedPath: "src/lib/file.ts",
    note: "lstat vs stat.",
  },
  {
    query: "permission denied handling",
    expectedPath: "src/lib/file.ts",
    note: "Access errors.",
  },
  {
    query: "graceful shutdown on signal",
    expectedPath: "src/index.ts",
    note: "SIGINT/SIGTERM handling.",
  },
  {
    query: "timeout handling for worker",
    expectedPath: "src/lib/worker-manager.ts",
    note: "Request timeout logic.",
  },
];

import { getAutoStoreId } from "./lib/store-resolver";

const storeId = process.argv[2] ?? getAutoStoreId(process.cwd());
const topK = 20;

export function evaluateCase(
  response: SearchResponse,
  evalCase: EvalCase,
  timeMs: number,
): EvalResult {
  const expectedPaths = evalCase.expectedPath
    .split("|")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  const rank = response.data.findIndex((chunk) => {
    const path = chunk.metadata?.path?.toLowerCase() || "";
    return expectedPaths.some((expected) => path.includes(expected));
  });

  const avoidRank = response.data.findIndex((chunk) =>
    chunk.metadata?.path
      ?.toLowerCase()
      .includes(evalCase.avoidPath?.toLowerCase() || "_____"),
  );

  const hitAvoid =
    evalCase.avoidPath && avoidRank >= 0 && (rank === -1 || avoidRank < rank);
  const found = rank >= 0 && !hitAvoid;
  const rr = found ? 1 / (rank + 1) : 0;
  const recall = found && rank < 10 ? 1 : 0;

  return {
    rr,
    found,
    recall,
    path: evalCase.expectedPath,
    query: evalCase.query,
    note: evalCase.note,
    timeMs,
  };
}

async function run() {
  const store = new LocalStore();

  // 1. Ensure the store exists
  try {
    await store.retrieve(storeId);
  } catch {
    console.error(`❌ Store "${storeId}" does not exist!`);
    console.error(`   Run "osgrep index" first to create and populate the store.`);
    process.exit(1);
  }

  // 2. Check if store has data
  try {
    const testResult = await store.search(storeId, "test", 1);
    if (testResult.data.length === 0) {
      console.error(`⚠️  Store "${storeId}" appears to be empty!`);
      console.error(`   Run "osgrep index" to populate the store with data.`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Error checking store data:`, err);
    process.exit(1);
  }

  const results: EvalResult[] = [];

  console.log("Starting evaluation...\n");
  const startTime = performance.now();

  for (const c of cases) {
    const queryStart = performance.now();
    const res = await store.search(storeId, c.query, topK);
    const queryEnd = performance.now();
    const timeMs = queryEnd - queryStart;

    results.push(evaluateCase(res, c, timeMs));
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
