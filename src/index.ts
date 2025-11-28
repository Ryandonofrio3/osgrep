#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { program } from "commander";
import { doctor } from "./commands/doctor";
import { index } from "./commands/index";
import { list } from "./commands/list";
import { search } from "./commands/search";
import { setup } from "./commands/setup";
import { serve } from "./commands/serve";
import { installClaudeCode } from "./commands/claude-code";

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

program.addCommand(search, { isDefault: true });
program.addCommand(index);
program.addCommand(list);
program.addCommand(setup);
program.addCommand(serve);
program.addCommand(installClaudeCode);
program.addCommand(doctor);

program.parse();
