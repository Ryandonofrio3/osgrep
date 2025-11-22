"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const local_store_1 = require("./src/lib/local-store");
const benchmarkCases = [
    // Next.js - Server-side rendering
    {
        repo: "next.js",
        query: "Where does server-side rendering happen?",
        grepPattern: "serverSideRendering|renderToHTML|getServerSideProps",
        expectedConcepts: ["render", "server", "HTML", "SSR"],
        note: "Semantic: understands SSR concept. Grep: needs exact terms.",
    },
    {
        repo: "next.js",
        query: "How are API routes handled?",
        grepPattern: "api.*route|handleApiRequest",
        expectedConcepts: ["API", "route", "handler", "pages/api"],
        note: "Semantic: finds routing logic. Grep: needs pattern matching.",
    },
    {
        repo: "next.js",
        query: "What triggers hot module replacement?",
        grepPattern: "HMR|hot.*module|webpack.*hot",
        expectedConcepts: ["HMR", "hot", "reload", "update"],
        note: "Semantic: understands HMR behavior. Grep: acronym dependent.",
    },
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
        repo: "next.js",
        query: "prevent memory leaks in development",
        grepPattern: "memory.*leak|cleanup|dispose|unsubscribe",
        expectedConcepts: ["memory", "cleanup", "dispose"],
        note: "Semantic: finds cleanup patterns. Grep: exact phrases.",
    },
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
function runBenchmark(repoDir, cases) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        const results = [];
        const store = new local_store_1.LocalStore();
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
            let osgrepResult;
            try {
                const storeId = testCase.repo.replace(/[^a-z0-9]/gi, "_");
                const searchResults = yield store.search(storeId, testCase.query, 5);
                osgrepResult = {
                    topFile: ((_b = (_a = searchResults.data[0]) === null || _a === void 0 ? void 0 : _a.metadata) === null || _b === void 0 ? void 0 : _b.path) || "no results",
                    topScore: ((_c = searchResults.data[0]) === null || _c === void 0 ? void 0 : _c.score) || 0,
                    foundRelevant: searchResults.data.length > 0 &&
                        testCase.expectedConcepts.some((concept) => JSON.stringify(searchResults.data[0])
                            .toLowerCase()
                            .includes(concept.toLowerCase())),
                };
            }
            catch (error) {
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
            let rgResult;
            try {
                const rgOutput = (0, node_child_process_1.execSync)(`rg -i --max-count=1 '${testCase.grepPattern}' || echo "no matches"`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
                const rgLines = rgOutput.trim().split("\n");
                rgResult = {
                    matchCount: rgLines.filter((l) => l && l !== "no matches")
                        .length,
                    topFile: ((_d = rgLines[0]) === null || _d === void 0 ? void 0 : _d.split(":")[0]) || "no matches",
                };
            }
            catch (_e) {
                rgResult = { matchCount: 0, topFile: "no matches" };
            }
            const rgTime = performance.now() - rgStart;
            // 3. grep (standard search)
            console.log("  → Running grep...");
            const grepStart = performance.now();
            let grepResult;
            try {
                const grepOutput = (0, node_child_process_1.execSync)(`grep -ri --max-count=1 '${testCase.grepPattern.replace(/\\/g, "")}' . || echo "no matches"`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
                const grepLines = grepOutput.trim().split("\n");
                grepResult = {
                    matchCount: grepLines.filter((l) => l && l !== "no matches")
                        .length,
                };
            }
            catch (_f) {
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
    });
}
function printResults(results) {
    console.log("\n" + "=".repeat(100));
    console.log("📊 BENCHMARK RESULTS: osgrep vs ripgrep vs grep");
    console.log("=".repeat(100));
    let osgrepRelevant = 0;
    let rgFound = 0;
    let grepFound = 0;
    for (const r of results) {
        console.log(`\n🔍 Query: "${r.query}" (${r.repo})`);
        console.log(`   Note: ${r.note}`);
        console.log(`\n   osgrep:  ${r.osgrep.foundRelevant ? "✅" : "❌"} ${r.osgrep.topFile} (score: ${r.osgrep.topScore.toFixed(2)}) [${r.osgrep.timeMs.toFixed(0)}ms]`);
        console.log(`   ripgrep: ${r.ripgrep.matchCount > 0 ? "✓" : "❌"} ${r.ripgrep.topFile} (${r.ripgrep.matchCount} matches) [${r.ripgrep.timeMs.toFixed(0)}ms]`);
        console.log(`   grep:    ${r.grep.matchCount > 0 ? "✓" : "❌"} (${r.grep.matchCount} matches) [${r.grep.timeMs.toFixed(0)}ms]`);
        if (r.osgrep.foundRelevant)
            osgrepRelevant++;
        if (r.ripgrep.matchCount > 0)
            rgFound++;
        if (r.grep.matchCount > 0)
            grepFound++;
    }
    console.log("\n" + "=".repeat(100));
    console.log("📈 SUMMARY");
    console.log("=".repeat(100));
    console.log(`osgrep found relevant:  ${osgrepRelevant}/${results.length} (${((osgrepRelevant / results.length) * 100).toFixed(1)}%)`);
    console.log(`ripgrep found matches:  ${rgFound}/${results.length} (${((rgFound / results.length) * 100).toFixed(1)}%)`);
    console.log(`grep found matches:     ${grepFound}/${results.length} (${((grepFound / results.length) * 100).toFixed(1)}%)`);
    const avgOsgrep = results.reduce((sum, r) => sum + r.osgrep.timeMs, 0) / results.length;
    const avgRg = results.reduce((sum, r) => sum + r.ripgrep.timeMs, 0) / results.length;
    const avgGrep = results.reduce((sum, r) => sum + r.grep.timeMs, 0) / results.length;
    console.log(`\nAverage query time:`);
    console.log(`  osgrep:  ${avgOsgrep.toFixed(0)}ms`);
    console.log(`  ripgrep: ${avgRg.toFixed(0)}ms`);
    console.log(`  grep:    ${avgGrep.toFixed(0)}ms`);
    console.log("=".repeat(100));
}
function indexRepos(repoDir, repos) {
    return __awaiter(this, void 0, void 0, function* () {
        const store = new local_store_1.LocalStore();
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
                const storeId = repo.replace(/[^a-z0-9]/gi, "_");
                // Use the sync function from your codebase
                (0, node_child_process_1.execSync)(`osgrep index`, { stdio: "inherit" });
                console.log(`   ✅ Indexed ${repo}`);
            }
            catch (error) {
                console.log(`   ❌ Failed to index ${repo}: ${error}`);
            }
        }
        console.log("\n✅ Indexing complete!\n");
    });
}
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        const repoDir = process.argv[2] || path.join(process.env.HOME, "osgrep-benchmarks");
        const shouldIndex = process.argv.includes("--index");
        console.log(`\n🚀 osgrep Benchmark Suite`);
        console.log(`📁 Repository directory: ${repoDir}\n`);
        const uniqueRepos = [...new Set(benchmarkCases.map((c) => c.repo))];
        if (shouldIndex) {
            yield indexRepos(repoDir, uniqueRepos);
        }
        const results = yield runBenchmark(repoDir, benchmarkCases);
        printResults(results);
    });
}
main().catch((err) => {
    console.error("❌ Benchmark failed:", err);
    process.exit(1);
});
//# sourceMappingURL=benchmark.js.map