#!/usr/bin/env ts-node
/**
 * Deterministic Benchmark for osgrep
 *
 * Measures: MRR (Mean Reciprocal Rank), Recall@K, Precision@1
 * Fast, reproducible, suitable for CI/CD
 *
 * Usage:
 *   pnpm tsx benchmark/deterministic-eval.ts
 *   pnpm tsx benchmark/deterministic-eval.ts --repo /path/to/fastapi
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

interface TestCase {
  query: string;
  expected: {
    files: string[];        // Expected files in order of relevance
    symbols?: string[];     // Expected symbols (for precision)
    role?: 'ORCHESTRATION' | 'DEFINITION';  // Expected role of top result
  };
  category: 'implementation' | 'definition' | 'architecture' | 'trace';
}

interface EvalResult {
  query: string;
  category: string;
  mrr: number;           // Mean Reciprocal Rank (1 = perfect)
  recall_at_5: number;   // Did we find the expected file in top 5?
  precision_at_1: number; // Is the #1 result correct?
  role_match: boolean;   // Does top result have expected role?
  latency_ms: number;
  found_files: string[];
  top_result: {
    file: string;
    score: number;
    role: string;
    symbols: string[];
  } | null;
}

// ============================================================================
// TEST SUITE: FastAPI Codebase
// ============================================================================

const FASTAPI_TEST_CASES: TestCase[] = [
  // Category: Implementation (finding "how does X work")
  {
    query: "how does middleware stack construction work",
    expected: {
      files: [
        "applications.py",  // build_middleware_stack is here
        "middleware/asyncexitstack.py",
      ],
      symbols: ["build_middleware_stack"],
      role: "ORCHESTRATION",
    },
    category: "implementation",
  },
  {
    query: "request validation logic",
    expected: {
      files: [
        "dependencies/utils.py",  // request_body_to_args
        "routing.py",             // get_request_handler
      ],
      symbols: ["request_body_to_args", "get_request_handler"],
      role: "ORCHESTRATION",
    },
    category: "implementation",
  },
  {
    query: "dependency injection resolver",
    expected: {
      files: [
        "dependencies/utils.py",  // solve_dependencies
      ],
      symbols: ["solve_dependencies", "get_dependant"],
      role: "ORCHESTRATION",
    },
    category: "implementation",
  },
  {
    query: "OpenAPI schema generation",
    expected: {
      files: [
        "applications.py",   // openapi() method
        "openapi/utils.py",
      ],
      symbols: ["openapi"],
      role: "DEFINITION",
    },
    category: "implementation",
  },
  {
    query: "background tasks execution",
    expected: {
      files: [
        "background.py",
      ],
      symbols: ["BackgroundTasks"],
      role: "DEFINITION",
    },
    category: "implementation",
  },

  // Category: Definition (finding "where is X defined")
  {
    query: "APIRouter class definition",
    expected: {
      files: ["routing.py"],
      symbols: ["APIRouter"],
      role: "DEFINITION",
    },
    category: "definition",
  },
  {
    query: "FastAPI application class",
    expected: {
      files: ["applications.py"],
      symbols: ["FastAPI"],
      role: "DEFINITION",
    },
    category: "definition",
  },

  // Category: Architecture (broad understanding)
  {
    query: "dependency injection system architecture",
    expected: {
      files: [
        "dependencies/utils.py",
        "dependencies/models.py",
        "param_functions.py",
      ],
    },
    category: "architecture",
  },
  {
    query: "routing system",
    expected: {
      files: [
        "routing.py",
        "applications.py",
      ],
    },
    category: "architecture",
  },
];

// ============================================================================
// METRICS CALCULATION
// ============================================================================

function calculateMRR(expectedFiles: string[], actualFiles: string[]): number {
  // Find the rank of the first expected file in actual results
  for (const expectedFile of expectedFiles) {
    const rank = actualFiles.findIndex(f => f.includes(expectedFile));
    if (rank !== -1) {
      return 1 / (rank + 1);  // Reciprocal rank
    }
  }
  return 0;  // Not found
}

function calculateRecallAtK(expectedFiles: string[], actualFiles: string[], k: number): number {
  const topK = actualFiles.slice(0, k);
  const found = expectedFiles.some(expected =>
    topK.some(actual => actual.includes(expected))
  );
  return found ? 1 : 0;
}

function calculatePrecisionAt1(expectedFiles: string[], actualFiles: string[]): number {
  if (actualFiles.length === 0) return 0;
  const topResult = actualFiles[0];
  return expectedFiles.some(expected => topResult.includes(expected)) ? 1 : 0;
}

// ============================================================================
// OSGREP EXECUTION
// ============================================================================

function runOsgrep(query: string, repoPath: string): {
  results: any[];
  latency_ms: number;
} {
  const startTime = Date.now();

  try {
    const output = execSync(
      `node ${path.join(__dirname, '../dist/index.js')} search "${query}" --json`,
      {
        cwd: repoPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'ignore'],  // Suppress stderr
      }
    );

    const latency_ms = Date.now() - startTime;
    const parsed = JSON.parse(output);

    return {
      results: parsed.results || [],
      latency_ms,
    };
  } catch (error) {
    console.error(`Error running osgrep for query: "${query}"`, error);
    return { results: [], latency_ms: Date.now() - startTime };
  }
}

// ============================================================================
// EVALUATION
// ============================================================================

function evaluateQuery(testCase: TestCase, repoPath: string): EvalResult {
  const { results, latency_ms } = runOsgrep(testCase.query, repoPath);

  // Extract file paths from results
  const actualFiles = results.map(r => r.metadata?.path || '');

  // Get top result details
  const topResult = results[0] ? {
    file: results[0].metadata?.path || '',
    score: results[0].score || 0,
    role: results[0].role || '',
    symbols: results[0].defined_symbols || [],
  } : null;

  // Calculate metrics
  const mrr = calculateMRR(testCase.expected.files, actualFiles);
  const recall_at_5 = calculateRecallAtK(testCase.expected.files, actualFiles, 5);
  const precision_at_1 = calculatePrecisionAt1(testCase.expected.files, actualFiles);

  // Check role match
  const role_match = testCase.expected.role
    ? topResult?.role === testCase.expected.role
    : true;  // Not applicable if no expected role

  return {
    query: testCase.query,
    category: testCase.category,
    mrr,
    recall_at_5,
    precision_at_1,
    role_match,
    latency_ms,
    found_files: actualFiles.slice(0, 5),
    top_result: topResult,
  };
}

function runEvaluation(testCases: TestCase[], repoPath: string) {
  console.log('🔍 Running Deterministic Evaluation...\n');
  console.log(`Repository: ${repoPath}`);
  console.log(`Test cases: ${testCases.length}\n`);

  const results: EvalResult[] = [];

  for (const [index, testCase] of testCases.entries()) {
    console.log(`[${index + 1}/${testCases.length}] ${testCase.query}`);
    const result = evaluateQuery(testCase, repoPath);
    results.push(result);

    // Print quick feedback
    const status = result.precision_at_1 === 1 ? '✅' :
                   result.recall_at_5 === 1 ? '⚠️' : '❌';
    console.log(`  ${status} MRR: ${result.mrr.toFixed(3)}, P@1: ${result.precision_at_1}, R@5: ${result.recall_at_5}, Latency: ${result.latency_ms}ms`);
    if (result.top_result) {
      console.log(`     Top: ${result.top_result.file} (${result.top_result.role}, score: ${result.top_result.score.toFixed(2)})`);
    }
    console.log();
  }

  return results;
}

// ============================================================================
// REPORTING
// ============================================================================

function generateReport(results: EvalResult[]) {
  console.log('\n' + '='.repeat(80));
  console.log('📊 EVALUATION RESULTS');
  console.log('='.repeat(80) + '\n');

  // Overall metrics
  const avgMRR = results.reduce((sum, r) => sum + r.mrr, 0) / results.length;
  const avgRecall = results.reduce((sum, r) => sum + r.recall_at_5, 0) / results.length;
  const avgPrecision = results.reduce((sum, r) => sum + r.precision_at_1, 0) / results.length;
  const avgLatency = results.reduce((sum, r) => sum + r.latency_ms, 0) / results.length;
  const roleAccuracy = results.filter(r => r.role_match).length / results.length;

  console.log('Overall Metrics:');
  console.log(`  Mean Reciprocal Rank (MRR):  ${avgMRR.toFixed(3)} (higher is better, max 1.0)`);
  console.log(`  Recall@5:                     ${(avgRecall * 100).toFixed(1)}% (found in top 5)`);
  console.log(`  Precision@1:                  ${(avgPrecision * 100).toFixed(1)}% (top result correct)`);
  console.log(`  Role Classification Accuracy: ${(roleAccuracy * 100).toFixed(1)}%`);
  console.log(`  Average Latency:              ${avgLatency.toFixed(0)}ms\n`);

  // By category
  console.log('Metrics by Category:');
  const categories = Array.from(new Set(results.map(r => r.category)));

  for (const category of categories) {
    const categoryResults = results.filter(r => r.category === category);
    const catMRR = categoryResults.reduce((sum, r) => sum + r.mrr, 0) / categoryResults.length;
    const catRecall = categoryResults.reduce((sum, r) => sum + r.recall_at_5, 0) / categoryResults.length;
    const catPrecision = categoryResults.reduce((sum, r) => sum + r.precision_at_1, 0) / categoryResults.length;

    console.log(`  ${category}:`);
    console.log(`    MRR: ${catMRR.toFixed(3)}, Recall@5: ${(catRecall * 100).toFixed(0)}%, Precision@1: ${(catPrecision * 100).toFixed(0)}%`);
  }

  console.log('\n' + '='.repeat(80));

  // Failures (for debugging)
  const failures = results.filter(r => r.precision_at_1 === 0);
  if (failures.length > 0) {
    console.log('\n❌ Failed Queries (Precision@1 = 0):');
    for (const failure of failures) {
      console.log(`  - "${failure.query}"`);
      console.log(`    Expected: ${failure.found_files[0] || 'N/A'}`);
      if (failure.top_result) {
        console.log(`    Got: ${failure.top_result.file}`);
      }
    }
  }

  // Save results to JSON
  const outputPath = path.join(__dirname, 'results/deterministic-eval.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      mrr: avgMRR,
      recall_at_5: avgRecall,
      precision_at_1: avgPrecision,
      role_accuracy: roleAccuracy,
      avg_latency_ms: avgLatency,
    },
    results,
  }, null, 2));

  console.log(`\n💾 Results saved to: ${outputPath}`);

  return {
    mrr: avgMRR,
    recall: avgRecall,
    precision: avgPrecision,
  };
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  const args = process.argv.slice(2);
  const repoIndex = args.indexOf('--repo');
  const repoPath = repoIndex !== -1 && args[repoIndex + 1]
    ? args[repoIndex + 1]
    : path.join(__dirname, '../../fastapi/fastapi');  // Default to fastapi

  if (!fs.existsSync(repoPath)) {
    console.error(`❌ Repository not found: ${repoPath}`);
    console.error('Usage: pnpm tsx benchmark/deterministic-eval.ts --repo /path/to/repo');
    process.exit(1);
  }

  const results = runEvaluation(FASTAPI_TEST_CASES, repoPath);
  const summary = generateReport(results);

  // Exit with error if metrics are too low (for CI)
  if (summary.mrr < 0.7 || summary.precision < 0.6) {
    console.error('\n❌ Metrics below threshold!');
    process.exit(1);
  }

  console.log('\n✅ Evaluation passed!');
}

if (require.main === module) {
  main();
}

export { evaluateQuery, FASTAPI_TEST_CASES };
