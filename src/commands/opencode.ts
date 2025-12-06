import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

const TOOL_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "tool",
  "osgrep.ts",
);
const MCP_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "opencode.json",
);

const TOOL_DEFINITION = `
import { tool } from "@opencode-ai/plugin"

const SKILL = \`
---
name: osgrep
description: Semantic code search and call-graph tracing for AI agents. Finds code by concept, surfaces roles (ORCHESTRATION vs DEFINITION), and traces dependencies. Output is compact TSV for low token use.
allowed-tools: "Bash(osgrep:*), Read"
license: Apache-2.0
---

## Core Commands
- Search: \`osgrep search "how does auth work"\`
- Trace: \`osgrep trace "AuthService"\`
- Symbols: \`osgrep symbols "Auth"\`

## Output (Default = Compact TSV)
- One line per hit: \`path\\tlines\\tscore\\trole\\tconf\\tdefined\\tpreview\`
- Header includes query and count.
- Roles are short (\`ORCH/DEF/IMPL\`), confidence is \`H/M/L\`, scores are short (\`.942\`).
- Use \`path\` + \`lines\` with \`Read\` to fetch real code.

## When to Use
- Find implementations: “where is validation logic”
- Understand concepts: “how does middleware work”
- Explore architecture: “authentication system”
- Trace impact: “who calls X / what does X call”

## Quick Patterns
1) “How does X work?”
   - \`osgrep search "how does X work"\`
   - Read the top ORCH hits.
2) “Who calls this?”
   - \`osgrep --trace "SymbolName"\`
   - Read callers/callees, then jump with \`Read\`.
3) Narrow scope:
   - \`osgrep search "auth middleware" src/server\`

## Command Reference

### \`search [pattern] [path]\`
Semantic search. Returns ranked results with roles (ORCH/DEF/IMPL).
- \`--compact\`: TSV output (default for agents).
- \`--max-count N\`: Limit results.

### \`trace <symbol>\`
Show call graph for a specific symbol.
- Callers: Who calls this?
- Callees: What does this call?
- Definition: Where is it defined?

### \`symbols [filter]\`
List defined symbols.
- No args: List top 20 most referenced symbols.
- With filter: List symbols matching the pattern.
- \`-l N\`: Limit number of results.

## Tips
- Previews are hints; not a full substitute for reading the file.
- Results are hybrid (semantic + literal); longer natural language queries work best.
- If results span many dirs, start with ORCH hits to map the flow.

## Typical Workflow

1. **Discover** - Use \`search\` to find relevant code by
concept
    \`\`\`bash
    osgrep search "worker pool lifecycle" --compact
    # → src/lib/workers/pool.ts:112 WorkerPool
    \`\`\`

2. **Explore** - Use \`symbols\` to see related symbols
    \`\`\`bash
    osgrep symbols Worker
    # → WorkerPool, WorkerOrchestrator, spawnWorker, etc.
    \`\`\`

3. **Trace** - Use \`trace\` to map dependencies
    \`\`\`bash
    osgrep trace WorkerPool
    # → Shows callers, callees, definition
    \`\`\`

4. **Read** - Use the file paths from above with \`Read\` tool
    \`\`\`bash
    Read src/lib/workers/pool.ts:112-186
    \`\`\`
\`;

export default tool({
  description: SKILL,
  args: {
    args: tool.schema.string().describe("The arguments to pass to osgrep, e.g. 'search \"query\"' or 'trace Symbol'"),
  },
  async execute(params) {
    const result = await Bun.$\`osgrep \${params.args}\`.text()
    return result.trim()
  },
})`;

async function installPlugin() {
  try {
    fs.mkdirSync(path.dirname(TOOL_PATH), { recursive: true });

    if (!fs.existsSync(TOOL_PATH)) {
      fs.writeFileSync(TOOL_PATH, TOOL_DEFINITION);
      console.log("Successfully installed the osgrep tool");
    } else {
      console.log("The osgrep tool is already installed");
    }

    fs.mkdirSync(path.dirname(MCP_PATH), { recursive: true });

    if (!fs.existsSync(MCP_PATH)) {
      fs.writeFileSync(MCP_PATH, JSON.stringify({}, null, 2));
    }
    const mcpContent = fs.readFileSync(MCP_PATH, "utf-8");
    const mcpJson = JSON.parse(mcpContent);
    if (!mcpJson.$schema) {
      mcpJson.$schema = "https://opencode.ai/config.json";
    }
    if (!mcpJson.mcp) {
      mcpJson.mcp = {};
    }
    mcpJson.mcp.osgrep = {
      type: "local",
      command: ["osgrep", "mcp"],
      enabled: true,
    };
    fs.writeFileSync(MCP_PATH, JSON.stringify(mcpJson, null, 2));
    console.log("Successfully installed the osgrep tool in the OpenCode agent");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error installing tool: ${errorMessage}`);
    console.error((error as Error)?.stack);
    process.exit(1);
  }
}

async function uninstallPlugin() {
  try {
    if (fs.existsSync(TOOL_PATH)) {
      fs.unlinkSync(TOOL_PATH);
      console.log(
        "Successfully removed the osgrep tool from the OpenCode agent",
      );
    } else {
      console.log("The osgrep tool is not installed in the OpenCode agent");
    }

    if (fs.existsSync(MCP_PATH)) {
      const mcpContent = fs.readFileSync(MCP_PATH, "utf-8");
      const mcpJson = JSON.parse(mcpContent);
      delete mcpJson.mcp.osgrep;
      fs.writeFileSync(MCP_PATH, JSON.stringify(mcpJson, null, 2));
      console.log("Successfully removed the osgrep from the OpenCode agent");
    } else {
      console.log("The osgrep is not installed in the OpenCode agent");
    }
  } catch (error) {
    console.error(`Error uninstalling plugin: ${error}`);
    process.exit(1);
  }
}

export const installOpencode = new Command("install-opencode")
  .description("Install the osgrep tool in the OpenCode agent")
  .action(async () => {
    await installPlugin();
  });

export const uninstallOpencode = new Command("uninstall-opencode")
  .description("Uninstall the osgrep tool from the OpenCode agent")
  .action(async () => {
    await uninstallPlugin();
  });