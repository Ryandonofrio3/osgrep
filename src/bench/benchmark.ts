import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalStore } from "../lib/local-store";

type BenchmarkCase = {
  query: string;
  grepPattern: string; // What you'd try with grep/ripgrep
  expectedConcepts: string[]; // Concepts that should be found
  repo: string;
  note: string;
};

const benchmarkCases: BenchmarkCase[] = [
  // FastAPI - Dependency injection
  {
    repo: "fastapi",
    query: "How does dependency injection work?",
    grepPattern: "Depends\\(|dependency.*injection",
    expectedConcepts: ["dependency", "inject", "resolve"],
    note: "Semantic: finds DI pattern. Grep: needs exact syntax.",
  },
  {
    repo: "fastapi",
    query: "Where are request bodies validated?",
    grepPattern: "BaseModel|validate|request.*body",
    expectedConcepts: ["validation", "request", "body", "pydantic"],
    note: "Semantic: understands validation concept. Grep: class names.",
  },

  // Vite - Build optimization
  {
    repo: "vite",
    query: "How does code splitting work?",
    grepPattern: "code.*split|dynamic.*import|chunk",
    expectedConcepts: ["split", "chunk", "dynamic", "import"],
    note: "Semantic: finds splitting logic. Grep: needs terminology.",
  },
  {
    repo: "vite",
    query: "Where does the dev server start?",
    grepPattern: "createServer|startServer|dev.*server",
    expectedConcepts: ["server", "start", "listen", "dev"],
    note: "Semantic: finds server initialization. Grep: function names.",
  },

  // tRPC - Type safety
  {
    repo: "trpc",
    query: "How are types inferred across client and server?",
    grepPattern: "infer|type.*inference|TRPCClient",
    expectedConcepts: ["type", "infer", "client", "server"],
    note: "Semantic: understands type propagation. Grep: type keywords.",
  },

  // Drizzle - Query building
  {
    repo: "drizzle-orm",
    query: "How are SQL queries constructed?",
    grepPattern: "query.*builder|buildQuery|sql.*construct",
    expectedConcepts: ["query", "build", "SQL", "construct"],
    note: "Semantic: finds query building. Grep: builder patterns.",
  },

  // Zod - Schema validation
  {
    repo: "zod",
    query: "How does schema parsing work?",
    grepPattern: "parse|ZodSchema|validate",
    expectedConcepts: ["parse", "schema", "validate", "type"],
    note: "Semantic: understands parsing flow. Grep: method names.",
  },

  // Generic semantic tests
  {
    repo: "vite",
    query: "make builds faster",
    grepPattern: "optimize|performance|cache|faster",
    expectedConcepts: ["optimize", "performance", "cache"],
    note: "Semantic: finds optimization code. Grep: speed keywords.",
  },
  {
    repo: "fastapi",
    query: "handling errors gracefully",
    grepPattern: "error.*handler|exception|try.*catch",
    expectedConcepts: ["error", "exception", "handle"],
    note: "Semantic: finds error handling. Grep: try-catch blocks.",
  },
];

type BenchmarkResult = {
  query: string;
  repo: string;
  osgrep: {
    timeMs: number;
    topFile: string;
    topScore: number;
    foundRelevant: boolean;
  };
  ripgrep: {
    timeMs: number;
    matchCount: number;
    topFile: string;
  };
  grep: {
    timeMs: number;
    matchCount: number;
  };
  note: string;
};

async function runBenchmark(
  repoDir: string,
  cases: BenchmarkCase[],
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const store = new LocalStore();

  for (const testCase of cases) {
    const repoPath = path.join(repoDir, testCase.repo);

    if (!fs.existsSync(repoPath)) {
      console.log(`⚠️  Skipping ${testCase.repo} - not found at ${repoPath}`);
      continue;
    }

    console.log(`\n🧪 Testing: "${testCase.query}" in ${testCase.repo}`);
    process.chdir(repoPath);

    // 1. osgrep (semantic search)
    console.log("  → Running osgrep...");
    const osgrepStart = performance.now();
    let osgrepResult: {
      topFile: string;
      topScore: number;
      foundRelevant: boolean;
    };

    try {
      const storeId = testCase.repo.replace(/[^a-z0-9]/gi, "_");
      const searchResults = await store.search(storeId, testCase.query, 5);

      osgrepResult = {
        topFile: searchResults.data[0]?.metadata?.path || "no results",
        topScore: searchResults.data[0]?.score || 0,
        foundRelevant:
          searchResults.data.length > 0 &&
          testCase.expectedConcepts.some((concept) =>
            JSON.stringify(searchResults.data[0])
              .toLowerCase()
              .includes(concept.toLowerCase()),
          ),
      };
    } catch (error) {
      console.log(`    ❌ osgrep error: ${error}`);
      osgrepResult = {
        topFile: "error",
        topScore: 0,
        foundRelevant: false,
      };
    }
    const osgrepTime = performance.now() - osgrepStart;

    // 2. ripgrep (fast regex search)
    console.log("  → Running ripgrep...");
    const rgStart = performance.now();
    let rgResult: { matchCount: number; topFile: string };

    try {
      const rgProcess = spawnSync("rg", ["-i", "-c", testCase.grepPattern], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const rgOutput = rgProcess.stdout || "";
      const rgLines = rgOutput.trim().split("\n");
      
      // Parse count output (format: filename:count)
      let totalMatches = 0;
      let firstFile = "no matches";
      
      for (const line of rgLines) {
        if (line && line.includes(":")) {
          const [file, countStr] = line.split(":");
          const count = Number.parseInt(countStr, 10);
          if (count > 0) {
            totalMatches += count;
            if (firstFile === "no matches") {
              firstFile = file;
            }
          }
        }
      }
      
      rgResult = {
        matchCount: totalMatches,
        topFile: firstFile,
      };
    } catch {
      rgResult = { matchCount: 0, topFile: "no matches" };
    }
    const rgTime = performance.now() - rgStart;

    // 3. grep (standard search)
    console.log("  → Running grep...");
    const grepStart = performance.now();
    let grepResult: { matchCount: number };

    try {
      // Remove backslashes for grep (simpler regex syntax)
      const grepPattern = testCase.grepPattern.replace(/\\/g, "");
      const grepProcess = spawnSync("grep", ["-ri", "-c", grepPattern, "."], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const grepOutput = grepProcess.stdout || "";
      const grepLines = grepOutput.trim().split("\n");
      
      // Parse count output (format: filename:count)
      let totalMatches = 0;
      for (const line of grepLines) {
        if (line && line.includes(":")) {
          const countStr = line.split(":")[1];
          const count = Number.parseInt(countStr, 10);
          if (!Number.isNaN(count)) {
            totalMatches += count;
          }
        }
      }
      
      grepResult = { matchCount: totalMatches };
    } catch {
      grepResult = { matchCount: 0 };
    }
    const grepTime = performance.now() - grepStart;

    results.push({
      query: testCase.query,
      repo: testCase.repo,
      osgrep: {
        timeMs: osgrepTime,
        topFile: osgrepResult.topFile,
        topScore: osgrepResult.topScore,
        foundRelevant: osgrepResult.foundRelevant,
      },
      ripgrep: {
        timeMs: rgTime,
        matchCount: rgResult.matchCount,
        topFile: rgResult.topFile,
      },
      grep: {
        timeMs: grepTime,
        matchCount: grepResult.matchCount,
      },
      note: testCase.note,
    });

    console.log(`    ✓ osgrep: ${osgrepTime.toFixed(0)}ms`);
    console.log(`    ✓ ripgrep: ${rgTime.toFixed(0)}ms`);
    console.log(`    ✓ grep: ${grepTime.toFixed(0)}ms`);
  }

  return results;
}

function printResults(results: BenchmarkResult[]) {
  console.log(`\n${"=".repeat(100)}`);
  console.log("📊 BENCHMARK RESULTS: osgrep vs ripgrep vs grep");
  console.log("=".repeat(100));

  let osgrepRelevant = 0;
  let rgFound = 0;
  let grepFound = 0;

  for (const r of results) {
    console.log(`\n🔍 Query: "${r.query}" (${r.repo})`);
    console.log(`   Note: ${r.note}`);
    console.log(
      `\n   osgrep:  ${r.osgrep.foundRelevant ? "✅" : "❌"} ${r.osgrep.topFile} (score: ${r.osgrep.topScore.toFixed(2)}) [${r.osgrep.timeMs.toFixed(0)}ms]`,
    );
    console.log(
      `   ripgrep: ${r.ripgrep.matchCount > 0 ? "✓" : "❌"} ${r.ripgrep.topFile} (${r.ripgrep.matchCount} matches) [${r.ripgrep.timeMs.toFixed(0)}ms]`,
    );
    console.log(
      `   grep:    ${r.grep.matchCount > 0 ? "✓" : "❌"} (${r.grep.matchCount} matches) [${r.grep.timeMs.toFixed(0)}ms]`,
    );

    if (r.osgrep.foundRelevant) osgrepRelevant++;
    if (r.ripgrep.matchCount > 0) rgFound++;
    if (r.grep.matchCount > 0) grepFound++;
  }

  console.log(`\n${"=".repeat(100)}`);
  console.log("📈 SUMMARY");
  console.log("=".repeat(100));
  console.log(
    `osgrep found relevant:  ${osgrepRelevant}/${results.length} (${((osgrepRelevant / results.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `ripgrep found matches:  ${rgFound}/${results.length} (${((rgFound / results.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `grep found matches:     ${grepFound}/${results.length} (${((grepFound / results.length) * 100).toFixed(1)}%)`,
  );

  const avgOsgrep =
    results.reduce((sum, r) => sum + r.osgrep.timeMs, 0) / results.length;
  const avgRg =
    results.reduce((sum, r) => sum + r.ripgrep.timeMs, 0) / results.length;
  const avgGrep =
    results.reduce((sum, r) => sum + r.grep.timeMs, 0) / results.length;

  console.log(`\nAverage query time:`);
  console.log(`  osgrep:  ${avgOsgrep.toFixed(0)}ms`);
  console.log(`  ripgrep: ${avgRg.toFixed(0)}ms`);
  console.log(`  grep:    ${avgGrep.toFixed(0)}ms`);
  console.log("=".repeat(100));
}

async function indexRepos(repoDir: string, repos: string[]) {
  console.log("\n📚 Indexing repositories...\n");

  for (const repo of repos) {
    const repoPath = path.join(repoDir, repo);
    if (!fs.existsSync(repoPath)) {
      console.log(`⚠️  Skipping ${repo} - not found`);
      continue;
    }

    console.log(`📦 Indexing ${repo}...`);
    process.chdir(repoPath);

    try {
      // Index using osgrep CLI
      const indexProcess = spawnSync("osgrep", ["index"], { stdio: "inherit" });
      if (indexProcess.status === 0) {
        console.log(`   ✅ Indexed ${repo}`);
      } else {
        console.log(`   ❌ Failed to index ${repo}`);
      }
    } catch (error) {
      console.log(`   ❌ Failed to index ${repo}: ${error}`);
    }
  }
  console.log("\n✅ Indexing complete!\n");
}

async function main() {
  const repoDir =
    process.argv[2] ||
    path.join(process.env.HOME ?? os.homedir(), "osgrep-benchmarks");
  const shouldIndex = process.argv.includes("--index");

  console.log(`\n🚀 osgrep Benchmark Suite`);
  console.log(`📁 Repository directory: ${repoDir}\n`);

  const uniqueRepos = [...new Set(benchmarkCases.map((c) => c.repo))];

  if (shouldIndex) {
    await indexRepos(repoDir, uniqueRepos);
  }

  const results = await runBenchmark(repoDir, benchmarkCases);
  printResults(results);
}

main().catch((err) => {
  console.error("❌ Benchmark failed:", err);
  process.exit(1);
});
