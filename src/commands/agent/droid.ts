import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

const SKILL = `
---
name: osgrep
description: Semantic code search and call-graph tracing for AI agents. Finds code by concept, surfaces roles (ORCHESTRATION vs DEFINITION), and traces dependencies.
allowed-tools: "Bash(osgrep:*), Read"
license: Apache-2.0
---

## ⚠️ CRITICAL: Handling "Indexing" State
If any \`osgrep\` command returns a status indicating **"Indexing"**, **"Building"**, or **"Syncing"**:
1. **STOP** your current train of thought.
2. **INFORM** the user: "The semantic index is currently building. Search results will be incomplete."
3. **ASK**: "Do you want me to proceed with partial results, or wait for indexing to finish?"
   *(Do not assume you should proceed without confirmation).*

## Core Commands
- Search: \`osgrep "how does auth work" --compact\`
- Trace: \`osgrep trace "AuthService"\`
- Symbols: \`osgrep symbols "Auth"\`

## Output (Default = Compact TSV)
- One line per hit: \`path\\tlines\\tscore\\trole\\tconf\\tdefined\\tpreview\`
- Roles: \`ORCH\` (Orchestration), \`DEF\` (Definition), \`IMPL\` (Implementation).
- **Note:** If output is empty but valid, say "No semantic matches found."

## Typical Workflow

1. **Discover**
   \`\`\`bash
   osgrep "worker pool lifecycle" --compact
   \`\`\`

2. **Explore**
   \`\`\`bash
   osgrep symbols Worker
   \`\`\`

3. **Trace**
   \`\`\`bash
   osgrep trace WorkerPool
   \`\`\`

4. **Read**
   \`\`\`bash
   Read src/lib/workers/pool.ts:112-186
   \`\`\`
`;

// --- DROID CONFIG UTILS ---

type HookCommand = { type: "command"; command: string; timeout: number };
type HookEntry = { matcher?: string | null; hooks: HookCommand[] };
type HooksConfig = Record<string, HookEntry[]>;
type Settings = {
  hooks?: HooksConfig;
  enableHooks?: boolean;
  allowBackgroundProcesses?: boolean;
} & Record<string, unknown>;

function resolveDroidRoot(): string {
  const root = path.join(os.homedir(), ".factory");
  if (!fs.existsSync(root)) {
    throw new Error(
      `Factory Droid directory not found at ${root}. Run Factory Droid once to initialize.`,
    );
  }
  return root;
}

function writeFileIfChanged(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const already = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : undefined;
  if (already !== content) fs.writeFileSync(filePath, content);
}

function parseJsonWithComments(content: string): Record<string, unknown> {
  const stripped = content
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
  try {
    return JSON.parse(stripped);
  } catch {
    return {};
  }
}

function loadSettings(settingsPath: string): Settings {
  if (!fs.existsSync(settingsPath)) return {};
  return parseJsonWithComments(
    fs.readFileSync(settingsPath, "utf-8"),
  ) as Settings;
}

function saveSettings(
  settingsPath: string,
  settings: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function mergeHooks(
  existing: HooksConfig | undefined,
  incoming: HooksConfig,
): HooksConfig {
  const merged = existing ? JSON.parse(JSON.stringify(existing)) : {};
  for (const [event, entries] of Object.entries(incoming)) {
    const current = merged[event] || [];
    for (const entry of entries) {
      // Simple duplicate check based on command string
      const cmd = entry.hooks[0].command;
      if (!current.some((c: any) => c.hooks[0].command === cmd)) {
        current.push(entry);
      }
    }
    merged[event] = current;
  }
  return merged;
}

// --- MAIN INSTALLER ---

async function installPlugin() {
  const root = resolveDroidRoot();
  const hooksDir = path.join(root, "hooks", "osgrep");
  const skillsDir = path.join(root, "skills", "osgrep");
  const settingsPath = path.join(root, "settings.json");

  // 1. Install Hook Scripts (Start/Stop Daemon)
  // We expect these files to exist in your dist/hooks folder
  const startJsPath = path.join(hooksDir, "osgrep_start.js");
  const stopJsPath = path.join(hooksDir, "osgrep_stop.js");

  // Create these scripts dynamically if we don't want to read from dist
  const startScript = `
const { spawn } = require("child_process");
const fs = require("fs");
const out = fs.openSync("/tmp/osgrep.log", "a");
const child = spawn("osgrep", ["serve"], { detached: true, stdio: ["ignore", out, out] });
child.unref();
`;
  const stopScript = `
const { spawnSync, execSync } = require("child_process");
try { execSync("pkill -f 'osgrep serve'"); } catch {}
`;

  writeFileIfChanged(startJsPath, startScript.trim());
  writeFileIfChanged(stopJsPath, stopScript.trim());

  // 2. Install Skill (with Indexing Warning)
  writeFileIfChanged(path.join(skillsDir, "SKILL.md"), SKILL.trimStart());

  // 3. Configure Settings
  const hookConfig: HooksConfig = {
    SessionStart: [
      {
        matcher: "startup|resume",
        hooks: [
          { type: "command", command: `node "${startJsPath}"`, timeout: 10 },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          { type: "command", command: `node "${stopJsPath}"`, timeout: 10 },
        ],
      },
    ],
  };

  const settings = loadSettings(settingsPath);
  settings.enableHooks = true;
  settings.allowBackgroundProcesses = true;
  settings.hooks = mergeHooks(settings.hooks as HooksConfig, hookConfig);
  saveSettings(settingsPath, settings);

  console.log(`✅ osgrep installed for Factory Droid (Hooks + Skill)`);
}

async function uninstallPlugin() {
  const root = resolveDroidRoot();
  const hooksDir = path.join(root, "hooks", "osgrep");
  const skillsDir = path.join(root, "skills", "osgrep");

  if (fs.existsSync(hooksDir))
    fs.rmSync(hooksDir, { recursive: true, force: true });
  if (fs.existsSync(skillsDir))
    fs.rmSync(skillsDir, { recursive: true, force: true });

  console.log("✅ osgrep removed from Factory Droid");
  console.log(
    "NOTE: You may want to manually clean up 'hooks' in ~/.factory/settings.json",
  );
}

export const installDroid = new Command("install-droid")
  .description("Install osgrep for Factory Droid")
  .action(installPlugin);

export const uninstallDroid = new Command("uninstall-droid")
  .description("Uninstall osgrep from Factory Droid")
  .action(uninstallPlugin);
