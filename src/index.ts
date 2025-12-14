#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { program } from "commander";
import { installClaudeCode } from "./commands/agent/claude-code";
import { installCodex } from "./commands/agent/codex";
import { doctor } from "./commands/utility/doctor";
import { installDroid } from "./commands/agent/droid";
import { index } from "./commands/index";
import { list } from "./commands/utility/list";
import { mcp } from "./commands/agent/mcp";
import { installOpencode, uninstallOpencode } from "./commands/agent/opencode";
import { search } from "./commands/search";
import { serve } from "./commands/serve";
import { setup } from "./commands/setup";
import { symbols } from "./commands/symbols";

program
  .version(
    JSON.parse(
      fs.readFileSync(path.join(__dirname, "../package.json"), {
        encoding: "utf-8",
      }),
    ).version,
  )
  .option(
    "--store <string>",
    "The store to use (auto-detected if not specified)",
    process.env.OSGREP_STORE || undefined,
  );

const legacyDataPath = path.join(
  require("node:os").homedir(),
  ".osgrep",
  "data",
);
const isIndexCommand = process.argv.some((arg) => arg === "index");
if (isIndexCommand && fs.existsSync(legacyDataPath)) {
  console.log("⚠️  Legacy global database detected at ~/.osgrep/data.");
  console.log("   osgrep now uses per-project .osgrep/ directories.");
  console.log(
    "   Run 'osgrep index' in your project root to create a new index.",
  );
}

program.addCommand(search, { isDefault: true });
program.addCommand(index);
program.addCommand(list);
program.addCommand(symbols);
program.addCommand(setup);
program.addCommand(serve);
program.addCommand(mcp);
program.addCommand(installClaudeCode);
program.addCommand(installCodex);
program.addCommand(installDroid);
program.addCommand(installOpencode);
program.addCommand(uninstallOpencode);
program.addCommand(doctor);

program.parse();
