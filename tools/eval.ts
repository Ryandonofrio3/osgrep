import { Searcher } from "../src/lib/search/searcher";
import type { SearchResponse } from "../src/lib/store/types";
import { VectorDB } from "../src/lib/store/vector-db";
import { gracefulExit } from "../src/lib/utils/exit";
import {
  ensureProjectPaths,
  findProjectRoot,
} from "../src/lib/utils/project-root";

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
  // --- Search & Ranking ---
  {
    query: "How do we merge vector and keyword results before rerank?",
    expectedPath: "src/lib/search/searcher.ts",
    note: "Hybrid search path that stitches LanceDB vector search with FTS.",
  },
  {
    query: "Where do we dedupe overlapping vector and FTS candidates?",
    expectedPath: "src/lib/search/searcher.ts",
    note: "Combines results and removes duplicates ahead of rerank.",
  },
  {
    query: "How do we boost functions and downweight tests or docs?",
    expectedPath: "src/lib/search/searcher.ts",
    note: "applyStructureBoost handles path/type based adjustments.",
  },
  {
    query: "What controls the pre-rerank candidate fanout?",
    expectedPath: "src/lib/search/searcher.ts",
    note: "PRE_RERANK_K calculation before ColBERT scoring.",
  },
  {
    query: "How do we filter searches to a path prefix?",
    expectedPath: "src/lib/search/searcher.ts",
    note: "Path prefix WHERE clause for scoped queries.",
  },
  {
    query: "How do we apply ColBERT rerank scoring to candidates?",
    expectedPath: "src/lib/workers/orchestrator.ts",
    note: "Worker-side rerank that feeds query/docs into maxSim.",
  },
  {
    query: "ColBERT maxSim scoring implementation",
    expectedPath: "src/lib/workers/colbert-math.ts",
    note: "Summed max dot products between query and doc token grids.",
  },

  // --- Worker Pool & Embeddings ---
  {
    query: "Why are ONNX workers child processes instead of threads?",
    expectedPath: "src/lib/workers/pool.ts",
    note: "Process pool choice to isolate runtime crashes.",
  },
  {
    query: "How do we timeout and restart stuck worker tasks?",
    expectedPath: "src/lib/workers/pool.ts",
    note: "Task timeout handling that kills and respawns workers.",
  },
  {
    query: "Which script does the worker pool fork at runtime?",
    expectedPath: "src/lib/workers/pool.ts",
    note: "resolveProcessWorker chooses process-child entrypoint.",
  },
  {
    query: "How does worker pool shutdown terminate children?",
    expectedPath: "src/lib/workers/pool.ts",
    note: "destroy() kills processes with SIGTERM/SIGKILL fallback.",
  },
  {
    query: "Where are Granite embeddings loaded from onnx cache?",
    expectedPath: "src/lib/workers/embeddings/granite.ts",
    note: "resolvePaths + load selecting ONNX weights and tokenizer.",
  },
  {
    query: "How do we mean-pool Granite outputs to 384 dimensions?",
    expectedPath: "src/lib/workers/embeddings/granite.ts",
    note: "meanPool normalizes and pads vectors to CONFIG.VECTOR_DIM.",
  },
  {
    query: "How does ColBERT quantize token grids to int8 with a scale?",
    expectedPath: "src/lib/workers/embeddings/colbert.ts",
    note: "runBatch builds int8 arrays and records maxVal scale.",
  },
  {
    query: "Where do we compute pooled_colbert_48d summaries?",
    expectedPath: "src/lib/workers/embeddings/colbert.ts",
    note: "Per-chunk pooled embedding stored alongside dense vectors.",
  },
  {
    query: "How do we normalize ColBERT query embeddings before rerank?",
    expectedPath: "src/lib/workers/orchestrator.ts",
    note: "encodeQuery builds normalized matrix from ONNX output.",
  },
  {
    query: "How are dense and ColBERT embeddings combined for each chunk?",
    expectedPath: "src/lib/workers/orchestrator.ts",
    note: "computeHybrid pairs Granite dense vectors with ColBERT grids.",
  },
  {
    query: "Where do we build anchor chunks with imports and preamble?",
    expectedPath: "src/lib/index/chunker.ts",
    note: "buildAnchorChunk prepends metadata-heavy anchor blocks.",
  },
  {
    query: "How is breadcrumb formatting added to chunk text?",
    expectedPath: "src/lib/index/chunker.ts",
    note: "formatChunkText injects file + context headers.",
  },
  {
    query: "What are the chunk overlap and max size settings?",
    expectedPath: "src/lib/index/chunker.ts",
    note: "MAX_CHUNK_LINES/CHARS and OVERLAP tuning in TreeSitterChunker.",
  },
  {
    query: "How do we fall back when a Tree-sitter grammar is missing?",
    expectedPath: "src/lib/index/chunker.ts",
    note: "chunk() fallback path when parser/grammar cannot load.",
  },
  {
    query: "Where are grammars downloaded and cached?",
    expectedPath: "src/lib/index/grammar-loader.ts",
    note: "GRAMMARS_DIR and ensureGrammars downloader.",
  },
  {
    query: "Which languages and grammars are supported for chunking?",
    expectedPath: "src/lib/core/languages.ts",
    note: "LANGUAGES table that maps extensions to grammars.",
  },

  // --- Indexing & Sync ---
  {
    query: "Where do we enforce a writer lock to prevent concurrent indexing?",
    expectedPath: "src/lib/utils/lock.ts",
    note: "LOCK file acquisition and stale process detection.",
  },
  {
    query: "Where is DEFAULT_IGNORE_PATTERNS defined for indexing?",
    expectedPath: "src/lib/index/ignore-patterns.ts",
    note: "DEFAULT_IGNORE_PATTERNS with lockfiles and secrets.",
  },
  {
    query: "Which INDEXABLE_EXTENSIONS are allowed and what is the 10MB limit?",
    expectedPath: "src/config.ts",
    note: "INDEXABLE_EXTENSIONS and MAX_FILE_SIZE_BYTES.",
  },
  {
    query: "How do we reset when VectorDB and meta cache disagree?",
    expectedPath: "src/lib/index/syncer.ts",
    note: "Inconsistency detection that forces drop + rebuild.",
  },
  {
    query: "How are batches flushed to LanceDB before updating meta cache?",
    expectedPath: "src/lib/index/syncer.ts",
    note: "flushBatch writes VectorDB first, then meta entries.",
  },
  {
    query: "How do we remove stale or deleted paths from the index?",
    expectedPath: "src/lib/index/syncer.ts",
    note: "Cleanup of stale paths after scanning is finished.",
  },
  {
    query: "How do we skip unchanged files using mtime/size hashes?",
    expectedPath: "src/lib/index/syncer.ts",
    note: "Meta cache check to bypass re-embedding identical files.",
  },
  {
    query:
      "When does processFile mark shouldDelete for binary, empty, or too-big files?",
    expectedPath: "src/lib/workers/orchestrator.ts",
    note: "processFile returns shouldDelete for non-indexable snapshots.",
  },
  {
    query: "How is the file hash computed for change detection?",
    expectedPath: "src/lib/utils/file-utils.ts",
    note: "computeBufferHash SHA-256 helper.",
  },
  {
    query: "How do we snapshot a file and verify it didn't change during read?",
    expectedPath: "src/lib/utils/file-utils.ts",
    note: "readFileSnapshot double-checks size/mtime before returning.",
  },

  // --- Storage & Schema ---
  {
    query: "Where is the LanceDB schema defined, including pooled_colbert_48d?",
    expectedPath: "src/lib/store/vector-db.ts",
    note: "Schema with dense, colbert, and pooled embeddings.",
  },
  {
    query: "How do we warn about schema mismatches and ask for a reindex?",
    expectedPath: "src/lib/store/vector-db.ts",
    note: "insertBatch error message for field mismatches.",
  },
  {
    query: "Where do we create the full-text index on chunk content?",
    expectedPath: "src/lib/store/vector-db.ts",
    note: "createFTSIndex invoking LanceDB FTS.",
  },

  // --- CLI Commands ---
  {
    query:
      "How does the search command trigger initial indexing when the store is empty?",
    expectedPath: "src/commands/search.ts",
    note: "Checks hasAnyRows and runs initialSync + spinner.",
  },
  {
    query: "Where does search --dry-run print formatDryRunSummary?",
    expectedPath: "src/commands/search.ts",
    note: "formatDryRunSummary usage for dry-run summaries.",
  },
  {
    query:
      "How does the index command handle --reset then call createFTSIndex?",
    expectedPath: "src/commands/index.ts",
    note: "Indexing workflow before createFTSIndex.",
  },
  {
    query: "How does serve reject search paths outside the project root?",
    expectedPath: "src/commands/serve.ts",
    note: "Path normalization rejecting traversal outside projectRoot.",
  },
  {
    query: "Where does the server enforce a 1MB payload size limit?",
    expectedPath: "src/commands/serve.ts",
    note: "Request body guard that 413s payloads over 1MB.",
  },
  {
    query:
      "How does serve --background redirect logs to ~/.osgrep/logs/server.log?",
    expectedPath: "src/commands/serve.ts",
    note: "Background flag redirecting stdio to server.log.",
  },
  {
    query: "Where does setup ensureSetup runs and grammars get downloaded?",
    expectedPath: "src/commands/setup.ts",
    note: "Setup command invoking ensureSetup and ensureGrammars.",
  },
  {
    query: "How does doctor check PATHS.models for missing model directories?",
    expectedPath: "src/commands/doctor.ts",
    note: "Health checks for PATHS.models and MODEL_IDS.",
  },
  {
    query: "Where is Claude Code plugin installation defined?",
    expectedPath: "src/commands/claude-code.ts",
    note: "Marketplace add + install flow.",
  },

  // --- Paths, Config, Environment ---
  {
    query: "How do we create .osgrep directories and add them to .gitignore?",
    expectedPath: "src/lib/utils/project-root.ts",
    note: "ensureProjectPaths scaffolds directories and gitignore entry.",
  },
  {
    query: "How is the project root detected via .git or existing .osgrep?",
    expectedPath: "src/lib/utils/project-root.ts",
    note: "findProjectRoot walking parents and honoring repo roots.",
  },
  {
    query: "Where are PATHS.globalRoot, models, and grammars defined?",
    expectedPath: "src/config.ts",
    note: "PATHS pointing to ~/.osgrep directories.",
  },
  {
    query: "How do workers prefer a local ./models directory when present?",
    expectedPath: "src/lib/workers/orchestrator.ts",
    note: "env.localModelPath override when repo ships models.",
  },
  {
    query: "Where are VECTOR_DIM, COLBERT_DIM, and WORKER_THREADS configured?",
    expectedPath: "src/config.ts",
    note: "CONFIG with VECTOR_DIM, COLBERT_DIM, WORKER_THREADS.",
  },

  // --- Extended Coverage ---
  {
    query: "Where do we read WORKER_TIMEOUT_MS from OSGREP_WORKER_TIMEOUT_MS?",
    expectedPath: "src/config.ts",
    note: "WORKER_TIMEOUT_MS env override.",
  },
  {
    query: "Where is TASK_TIMEOUT_MS set for worker tasks?",
    expectedPath: "src/lib/workers/pool.ts",
    note: "OSGREP_WORKER_TASK_TIMEOUT_MS guarded timeout.",
  },
  {
    query:
      "How do we cap worker threads from OSGREP_WORKER_THREADS with a HARD_CAP of 4?",
    expectedPath: "src/config.ts",
    note: "DEFAULT_WORKER_THREADS calculation.",
  },
  {
    query: "Where do we set HF transformers cacheDir and allowLocalModels?",
    expectedPath: "src/lib/workers/orchestrator.ts",
    note: "env.cacheDir and env.allowLocalModels toggles.",
  },
  {
    query: "Where do we load Granite ONNX with CPU execution providers?",
    expectedPath: "src/lib/workers/embeddings/granite.ts",
    note: "load() builds sessionOptions for cpu backend.",
  },
  {
    query: "Where do we limit ColBERT ONNX runtime threads to 1?",
    expectedPath: "src/lib/workers/embeddings/colbert.ts",
    note: "ONNX_THREADS constant and session options.",
  },
  {
    query:
      "How do we normalize ColBERT doc vectors and quantize to int8 scale?",
    expectedPath: "src/lib/workers/embeddings/colbert.ts",
    note: "runBatch builds normalized grid and scale factor.",
  },
  {
    query: "Where do we normalize ColBERT query rows before building matrix?",
    expectedPath: "src/lib/workers/orchestrator.ts",
    note: "encodeQuery normalizes ONNX output rows.",
  },
  {
    query:
      "Where do we convert serialized Buffer objects to Int8Array for rerank?",
    expectedPath: "src/lib/workers/orchestrator.ts",
    note: "rerank converts Buffer/object into Int8Array.",
  },
  {
    query: "Where do we build UUIDs for chunk ids before inserting to LanceDB?",
    expectedPath: "src/lib/workers/orchestrator.ts",
    note: "toPreparedChunks uses uuidv4 for chunk IDs.",
  },
  {
    query:
      "How do we include imports, exports, and top comments in anchor chunks?",
    expectedPath: "src/lib/index/chunker.ts",
    note: "buildAnchorChunk composes sections with metadata.",
  },
  {
    query: "Where do we warn about missing tree-sitter grammars and fall back?",
    expectedPath: "src/lib/index/chunker.ts",
    note: "chunk() logs and falls back when getLanguage fails.",
  },
  {
    query: "Where do we split oversized chunks with line and char overlaps?",
    expectedPath: "src/lib/index/chunker.ts",
    note: "splitIfTooBig uses OVERLAP_LINES and OVERLAP_CHARS.",
  },
  {
    query: "Where is GRAMMARS_DIR set to ~/.osgrep/grammars?",
    expectedPath: "src/lib/index/grammar-loader.ts",
    note: "GRAMMARS_DIR constant.",
  },
  {
    query: "Where do we download grammars with fetch and a custom User-Agent?",
    expectedPath: "src/lib/index/grammar-loader.ts",
    note: "ensureGrammars downloadFile helper.",
  },
  {
    query: "Where do we guard against files changing during read?",
    expectedPath: "src/lib/utils/file-utils.ts",
    note: "readFileSnapshot compares pre/post stats.",
  },
  {
    query: "Where do we detect null bytes before indexing content?",
    expectedPath: "src/lib/utils/file-utils.ts",
    note: "hasNullByte check in processFile path.",
  },
  {
    query: "Where do we register cleanup tasks and execute them at exit?",
    expectedPath: "src/lib/utils/cleanup.ts",
    note: "registerCleanup and runCleanup functions.",
  },
  {
    query: "Where does gracefulExit destroy the worker pool before exiting?",
    expectedPath: "src/lib/utils/exit.ts",
    note: "gracefulExit calls destroyWorkerPool and runCleanup.",
  },
  {
    query: "Where is the LMDB meta cache opened with compression?",
    expectedPath: "src/lib/store/meta-cache.ts",
    note: "MetaCache constructor uses lmdb open() with compression.",
  },
  {
    query: "Where do we connect to LanceDB and seed the table schema?",
    expectedPath: "src/lib/store/vector-db.ts",
    note: "ensureTable creates schema and deletes seed row.",
  },
  {
    query: "Where do we drop the LanceDB table during resets?",
    expectedPath: "src/lib/store/vector-db.ts",
    note: "drop() helper invoked on reset.",
  },
  {
    query: "Where do we close LanceDB connections and unregister cleanup?",
    expectedPath: "src/lib/store/vector-db.ts",
    note: "close() method clears connections and cleanup hook.",
  },
  {
    query: "Where do we use fast-glob to stream files for indexing?",
    expectedPath: "src/lib/index/syncer.ts",
    note: "fg.stream with glob options for repo walk.",
  },
  {
    query: "Where do we skip duplicate real paths and broken symlinks?",
    expectedPath: "src/lib/index/syncer.ts",
    note: "visitedRealPaths plus try/catch around realpathSync.",
  },
  {
    query: "Where do we abort indexing when AbortSignal is triggered?",
    expectedPath: "src/lib/index/syncer.ts",
    note: "Checks signal.aborted to stop scheduling.",
  },
  {
    query:
      "Where do we flush batches when batch/deletes/meta reach batchLimit?",
    expectedPath: "src/lib/index/syncer.ts",
    note: "flush() checks batchLimit based on EMBED_BATCH_SIZE.",
  },
  {
    query:
      "Where do we detect stale cached paths and delete them after indexing?",
    expectedPath: "src/lib/index/syncer.ts",
    note: "Removes stale paths from VectorDB and meta cache.",
  },
  {
    query:
      "Where do we detect inconsistent VectorDB vs meta cache and force rebuild?",
    expectedPath: "src/lib/index/syncer.ts",
    note: "isInconsistent triggers drop and meta reset.",
  },
  {
    query:
      "Where is createIndexingSpinner updating text for scanning and indexing files?",
    expectedPath: "src/lib/index/sync-helpers.ts",
    note: "createIndexingSpinner onProgress formatting.",
  },
  {
    query:
      "Where does ensureSetup create ~/.osgrep directories with ora spinner?",
    expectedPath: "src/lib/setup/setup-helpers.ts",
    note: "ensureSetup directory creation feedback.",
  },
  {
    query:
      "Where do we download models via a worker thread to avoid ONNX in main thread?",
    expectedPath: "src/lib/setup/model-loader.ts",
    note: "downloadModels spawns worker with ts-node/register when dev.",
  },
  {
    query: "Where do we check areModelsDownloaded before running setup?",
    expectedPath: "src/lib/setup/model-loader.ts",
    note: "areModelsDownloaded verifies cache directories.",
  },
  {
    query:
      "Where does setup command list model and grammar status after finishing?",
    expectedPath: "src/commands/setup.ts",
    note: "Setup command status output with model IDs.",
  },
  {
    query: "Where does doctor print system platform, arch, and Node version?",
    expectedPath: "src/commands/doctor.ts",
    note: "Doctor command system info logging.",
  },
  {
    query: "Where does the list command calculate directory sizes recursively?",
    expectedPath: "src/commands/list.ts",
    note: "getDirectorySize walk.",
  },
  {
    query: "Where does the list command format sizes and time ago text?",
    expectedPath: "src/commands/list.ts",
    note: "formatSize and formatDate helpers.",
  },
  {
    query: "Where does serve register running servers to servers.json?",
    expectedPath: "src/lib/utils/server-registry.ts",
    note: "registerServer writes to ~/.osgrep/servers.json.",
  },
  {
    query: "How does serve status enumerate active servers?",
    expectedPath: "src/commands/serve.ts",
    note: "serve status subcommand uses listServers().",
  },
  {
    query: "How does serve stop --all kill background servers?",
    expectedPath: "src/commands/serve.ts",
    note: "serve stop iterates listServers and SIGTERMs.",
  },
  {
    query: "Where is the LOCK file written and stale PID detection handled?",
    expectedPath: "src/lib/utils/lock.ts",
    note: "acquireWriterLock parses existing lock with pid/start time.",
  },
  {
    query: "Where do we parse .git worktree files to find the main repo root?",
    expectedPath: "src/lib/utils/git.ts",
    note: "getMainRepoRoot and getGitCommonDir for worktrees.",
  },
  {
    query: "Where do we format search results in plain mode for agents?",
    expectedPath: "src/lib/utils/formatter.ts",
    note: "formatTextResults plain mode with agent tags.",
  },
  {
    query: "Where do we apply syntax highlighting for human output?",
    expectedPath: "src/lib/utils/formatter.ts",
    note: "formatTextResults uses cli-highlight when not plain.",
  },
  {
    query:
      "Where do we merge nearby snippets from the same file before printing?",
    expectedPath: "src/lib/utils/formatter.ts",
    note: "Smart stitching merges overlapping chunks per file.",
  },
  {
    query:
      "Where are search CLI options like --scores, --compact, --per-file handled?",
    expectedPath: "src/commands/search.ts",
    note: "Commander options declared for search command.",
  },
  {
    query: "Where is the search path argument normalized against project root?",
    expectedPath: "src/commands/search.ts",
    note: "Relative path handling before searcher.search.",
  },
];

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
  const root = process.cwd();
  const searchRoot = root;
  const projectRoot = findProjectRoot(searchRoot) ?? searchRoot;
  const paths = ensureProjectPaths(projectRoot);
  const vectorDb = new VectorDB(paths.lancedbDir);
  const searcher = new Searcher(vectorDb);

  // 1. Ensure the store exists (VectorDB handles creation, but we check for data)
  const hasRows = await vectorDb.hasAnyRows();
  if (!hasRows) {
    console.error(`❌ Store appears to be empty!`);
    console.error(`   Run "osgrep index" to populate the store with data.`);
    process.exit(1);
  }

  // 2. Check if store has data (redundant but good for sanity)
  try {
    const testResult = await searcher.search("test", 1, { rerank: true });
    if (testResult.data.length === 0) {
      console.error(
        `⚠️  Store appears to be empty (search returned 0 results)!`,
      );
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
    const res = await searcher.search(c.query, topK, { rerank: false });
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
  console.log(`Eval results for store at: ${paths.lancedbDir}`);
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

  await gracefulExit(0);
}

if (
  // Only auto-run when executed directly (not when imported for experiments/tests)
  require.main === module &&
  process.env.OSGREP_EVAL_AUTORUN !== "0"
) {
  run().catch((err) => {
    console.error("Eval failed:", err);
    gracefulExit(1);
  });
}
