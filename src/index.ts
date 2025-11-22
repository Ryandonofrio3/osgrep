#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { program } from "commander";
import { doctor } from "./commands/doctor";
import { index } from "./commands/index";
import { search } from "./commands/search";
import { setup } from "./commands/setup";
import { installClaudeCode } from "./install/claude-code";

// utility functions moved to ./utils

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
    "The store to use",
    process.env.MXBAI_STORE || "osgrep",
  );

program.addCommand(search, { isDefault: true });
program.addCommand(index);
program.addCommand(setup);
program.addCommand(installClaudeCode);
program.addCommand(doctor);

program.parse();
