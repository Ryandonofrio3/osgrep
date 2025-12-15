import { Command } from "commander";
import { GraphBuilder, type CallGraph } from "../lib/graph/graph-builder";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

const style = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
};

/**
 * Dedupe and count callees. Returns "foo bar baz" or "foo bar (x3) baz" for repeats.
 */
function formatCallees(callees: string[]): string {
  const counts = new Map<string, number>();
  for (const c of callees) {
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} (x${count})` : name))
    .join(" ");
}

/**
 * Group callers by file. Returns map of file -> line numbers.
 */
function groupCallersByFile(
  callers: Array<{ file: string; line: number; symbol: string }>,
): Map<string, number[]> {
  const byFile = new Map<string, number[]>();
  for (const c of callers) {
    const lines = byFile.get(c.file) || [];
    lines.push(c.line);
    byFile.set(c.file, lines);
  }
  // Sort lines within each file
  for (const lines of byFile.values()) {
    lines.sort((a, b) => a - b);
  }
  return byFile;
}

/**
 * Count total items for format decision.
 */
function countItems(graph: CallGraph): number {
  const uniqueCallees = new Set(graph.callees).size;
  const callerFiles = groupCallersByFile(graph.callers).size;
  return uniqueCallees + callerFiles;
}

/**
 * Format call graph for minimal agent-friendly output.
 * Uses tree format for small results, compact grouped format for large.
 */
function formatPlain(graph: CallGraph, symbol: string): string {
  const itemCount = countItems(graph);

  // Use tree format for small results (cleaner), compact for large
  if (itemCount <= 10) {
    return formatPlainTree(graph, symbol);
  }
  return formatPlainCompact(graph, symbol);
}

/**
 * Tree format for small results - cleaner to read.
 */
function formatPlainTree(graph: CallGraph, symbol: string): string {
  const lines: string[] = [];

  if (graph.center) {
    lines.push(`${symbol} (${graph.center.file}:${graph.center.line})`);
  } else {
    lines.push(`${symbol} (not found)`);
  }

  const hasCallees = graph.callees.length > 0;
  const hasCallers = graph.callers.length > 0;

  if (hasCallees) {
    const branch = hasCallers ? "├──" : "└──";
    lines.push(`${branch} calls:`);

    // Dedupe callees
    const counts = new Map<string, number>();
    for (const c of graph.callees) {
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    const calleeList = [...counts.entries()];

    calleeList.forEach(([name, count], i) => {
      const prefix = hasCallers ? "│   " : "    ";
      const sym = i === calleeList.length - 1 ? "└──" : "├──";
      const countStr = count > 1 ? ` (x${count})` : "";
      lines.push(`${prefix}${sym} ${name}${countStr}`);
    });
  }

  if (hasCallers) {
    lines.push("└── called by:");
    const byFile = groupCallersByFile(graph.callers);
    const files = [...byFile.entries()];

    files.forEach(([file, fileLines], i) => {
      const sym = i === files.length - 1 ? "└──" : "├──";
      const lineStr =
        fileLines.length === 1
          ? `line ${fileLines[0]}`
          : `lines ${fileLines.join(", ")}`;
      lines.push(`    ${sym} ${file}: ${lineStr}`);
    });
  }

  if (!hasCallees && !hasCallers) {
    lines.push("    (no callers or callees found)");
  }

  return lines.join("\n");
}

/**
 * Compact grouped format for large results.
 */
function formatPlainCompact(graph: CallGraph, symbol: string): string {
  const lines: string[] = [];
  lines.push(symbol);

  if (graph.center) {
    lines.push(`  def: ${graph.center.file}:${graph.center.line}`);
  } else {
    lines.push("  def: (not found)");
  }

  if (graph.callees.length > 0) {
    lines.push(`  calls: ${formatCallees(graph.callees)}`);
  }

  if (graph.callers.length > 0) {
    lines.push("  called_by:");
    const byFile = groupCallersByFile(graph.callers);
    for (const [file, fileLines] of byFile) {
      const lineStr =
        fileLines.length === 1
          ? `line ${fileLines[0]}`
          : `lines ${fileLines.join(", ")}`;
      lines.push(`    ${file}: ${lineStr}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format call graph as a tree for human-readable output.
 */
function formatTree(graph: CallGraph, symbol: string): string {
  const lines: string[] = [];

  if (graph.center) {
    const role = graph.center.role ? ` ${style.dim(graph.center.role)}` : "";
    lines.push(
      `${style.bold(symbol)} (${style.cyan(`${graph.center.file}:${graph.center.line}`)})${role}`,
    );
  } else {
    lines.push(`${style.bold(symbol)} ${style.dim("(definition not found)")}`);
  }

  const hasCallees = graph.callees.length > 0;
  const hasCallers = graph.callers.length > 0;

  if (hasCallees) {
    const branch = hasCallers ? "\u251c\u2500\u2500" : "\u2514\u2500\u2500";
    lines.push(`${branch} ${style.yellow("calls:")}`);
    graph.callees.forEach((callee, i) => {
      const prefix = hasCallers ? "\u2502   " : "    ";
      const sym =
        i === graph.callees.length - 1
          ? "\u2514\u2500\u2500"
          : "\u251c\u2500\u2500";
      lines.push(`${prefix}${sym} ${callee}`);
    });
  }

  if (hasCallers) {
    lines.push(`\u2514\u2500\u2500 ${style.green("called by:")}`);
    graph.callers.forEach((caller, i) => {
      const sym =
        i === graph.callers.length - 1
          ? "\u2514\u2500\u2500"
          : "\u251c\u2500\u2500";
      lines.push(
        `    ${sym} ${caller.symbol} (${style.cyan(`${caller.file}:${caller.line}`)})`,
      );
    });
  }

  if (!hasCallees && !hasCallers) {
    lines.push(style.dim("  (no callers or callees found)"));
  }

  return lines.join("\n");
}

/**
 * Format call graph as JSON for programmatic use.
 */
function formatJson(graph: CallGraph, symbol: string): string {
  return JSON.stringify(
    {
      symbol,
      center: graph.center
        ? {
            file: graph.center.file,
            line: graph.center.line,
            role: graph.center.role,
          }
        : null,
      callers: graph.callers.map((c) => ({
        symbol: c.symbol,
        file: c.file,
        line: c.line,
      })),
      callees: graph.callees,
    },
    null,
    2,
  );
}

export const trace = new Command("trace")
  .description("Show call graph for a symbol (callers and callees)")
  .argument("<symbol>", "Symbol name to trace")
  .option("-d, --depth <n>", "Traversal depth (default: 1)", "1")
  .option("--callers", "Show only callers (who calls this)")
  .option("--callees", "Show only callees (what this calls)")
  .option("-p, --path <prefix>", "Filter to path prefix")
  .option("--pretty", "Pretty tree output (default for TTY)")
  .option("--plain", "Plain minimal output (default for non-TTY)")
  .option("--json", "JSON output")
  .action(async (symbol, cmd) => {
    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
    const paths = ensureProjectPaths(projectRoot);
    const db = new VectorDB(paths.lancedbDir);

    try {
      const builder = new GraphBuilder(db);

      const graph = await builder.buildGraph(symbol, {
        depth: Number.parseInt(cmd.depth, 10) || 1,
        callersOnly: cmd.callers as boolean,
        calleesOnly: cmd.callees as boolean,
        pathPrefix: cmd.path as string | undefined,
      });

      // Determine output format
      let output: string;
      if (cmd.json) {
        output = formatJson(graph, symbol);
      } else if (cmd.pretty) {
        output = formatTree(graph, symbol);
      } else if (cmd.plain || !process.stdout.isTTY) {
        output = formatPlain(graph, symbol);
      } else {
        output = formatTree(graph, symbol);
      }

      console.log(output);
    } finally {
      await db.close();
    }

    await gracefulExit();
  });
