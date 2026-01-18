#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { program } from "commander";
import { installClaudeCode } from "./commands/claude-code";
import { installCodex } from "./commands/codex";
import { doctor } from "./commands/doctor";
import { installDroid } from "./commands/droid";
import { index } from "./commands/index";
import { list } from "./commands/list";
import { mcp } from "./commands/mcp";
import { installOpencode, uninstallOpencode } from "./commands/opencode";
import { search } from "./commands/search";
import { serve } from "./commands/serve";
import { setup } from "./commands/setup";
import { skeleton } from "./commands/skeleton";
import { symbols } from "./commands/symbols";
import { trace } from "./commands/trace";
import { PATHS } from "./config";

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

const legacyDataPath = path.join(PATHS.globalRoot, "data");
const isIndexCommand = process.argv.some((arg) => arg === "index");
if (isIndexCommand && fs.existsSync(legacyDataPath)) {
  console.log(
    `⚠️  Legacy global database detected at ${PATHS.globalRoot}/data.`,
  );
  console.log("   osgrep now uses per-project .osgrep/ directories.");
  console.log(
    "   Run 'osgrep index' in your project root to create a new index.",
  );
}

program.addCommand(search, { isDefault: true });
program.addCommand(index);
program.addCommand(list);
program.addCommand(skeleton);
program.addCommand(symbols);
program.addCommand(trace);
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
