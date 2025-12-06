import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";

const shell =
  process.env.SHELL ||
  (process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "/bin/sh");

const SKILL = `
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
- Find implementations: "where is validation logic"
- Understand concepts: "how does middleware work"
- Explore architecture: "authentication system"
- Trace impact: "who calls X / what does X call"

## Quick Patterns
1) "How does X work?"
   - \`osgrep search "how does X work"\`
   - Read the top ORCH hits.
2) "Who calls this?"
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
`;

const execAsync = promisify(exec);

async function installPlugin() {
  try {
    await execAsync("codex mcp add osgrep osgrep mcp", {
      shell,
      env: process.env,
    });
    console.log("Successfully installed the osgrep background sync");

    const destPath = path.join(os.homedir(), ".codex", "AGENTS.md");
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    let existingContent = "";
    if (fs.existsSync(destPath)) {
      existingContent = fs.readFileSync(destPath, "utf-8");
    }

    const skillTrimmed = SKILL.trim();
    if (
      !existingContent.includes(SKILL) &&
      !existingContent.includes(skillTrimmed)
    ) {
      fs.appendFileSync(destPath, SKILL);
      console.log("Successfully added the osgrep to the Codex agent");
    } else {
      console.log("The osgrep skill is already installed in the Codex agent");
    }
  } catch (error) {
    console.error(`Error installing plugin: ${error}`);
    process.exit(1);
  }
}

async function uninstallPlugin() {
  try {
    await execAsync("codex mcp remove osgrep", { shell, env: process.env });
  } catch (error) {
    console.error(`Error uninstalling plugin: ${error}`);
    process.exit(1);
  }

  const destPath = path.join(os.homedir(), ".codex", "AGENTS.md");
  if (fs.existsSync(destPath)) {
    const existingContent = fs.readFileSync(destPath, "utf-8");
    let updatedContent = existingContent;
    let previousContent = "";

    while (updatedContent !== previousContent) {
      previousContent = updatedContent;
      updatedContent = updatedContent.replace(SKILL, "");
      updatedContent = updatedContent.replace(SKILL.trim(), "");
    }

    if (updatedContent.trim() === "") {
      fs.unlinkSync(destPath);
    } else {
      fs.writeFileSync(destPath, updatedContent);
    }
  }
  console.log("Successfully removed the osgrep from the Codex agent");
}

export const installCodex = new Command("install-codex")
  .description("Install the Codex agent")
  .action(async () => {
    await installPlugin();
  });

export const uninstallCodex = new Command("uninstall-codex")
  .description("Uninstall the Codex agent")
  .action(async () => {
    await uninstallPlugin();
  });