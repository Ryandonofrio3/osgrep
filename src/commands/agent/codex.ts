import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";

const shell =
  process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
const execAsync = promisify(exec);

const SKILL = `
---
name: osgrep
description: Semantic code search and call-graph tracing via osgrep.
---

## ⚠️ CRITICAL: Handling "Indexing" State
If the tool output says **"Indexing"**, **"Building"**, or **"Syncing"**:
1. **STOP.** Do not hallucinate results.
2. **INFORM** the user: "The semantic index is still building. Results are partial."
3. **ASK** if they want to proceed or wait.

## Commands
- Search: \`osgrep "auth logic" --compact\`
- Trace: \`osgrep trace "AuthService"\`
`;

async function installPlugin() {
  try {
    // 1. Register the MCP Tool
    // 'osgrep mcp' acts as the server.
    await execAsync("codex mcp add osgrep osgrep mcp", {
      shell,
      env: process.env,
    });
    console.log("✅ osgrep MCP tool registered with Codex");

    // 2. Add Instructions to AGENTS.md
    const destPath = path.join(os.homedir(), ".codex", "AGENTS.md");
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const content = fs.existsSync(destPath)
      ? fs.readFileSync(destPath, "utf-8")
      : "";

    // Only append if not present
    if (!content.includes("name: osgrep")) {
      fs.appendFileSync(destPath, "\n" + SKILL);
      console.log("✅ osgrep skill instructions added to Codex");
    } else {
      console.log("ℹ️  osgrep skill instructions already present");
    }
  } catch (error) {
    console.error(`❌ Error installing Codex plugin: ${error}`);
    process.exit(1);
  }
}

async function uninstallPlugin() {
  try {
    await execAsync("codex mcp remove osgrep", { shell, env: process.env });
    console.log("✅ osgrep MCP tool removed");
  } catch (e) {
    /* ignore if not found */
  }

  const destPath = path.join(os.homedir(), ".codex", "AGENTS.md");
  if (fs.existsSync(destPath)) {
    let content = fs.readFileSync(destPath, "utf-8");
    // Naive removal: strictly matches the block we added.
    // For robust removal, you might need regex, but this works if the string is exact.
    if (content.includes(SKILL)) {
      content = content.replace(SKILL, "").trim();
      fs.writeFileSync(destPath, content);
      console.log("✅ osgrep instructions removed from AGENTS.md");
    }
  }
}

export const installCodex = new Command("install-codex")
  .description("Install osgrep for Codex")
  .action(installPlugin);

export const uninstallCodex = new Command("uninstall-codex")
  .description("Uninstall osgrep from Codex")
  .action(uninstallPlugin);
