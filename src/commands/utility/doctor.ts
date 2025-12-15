import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { PATHS } from "../../config";
import { initNative } from "../../lib/native";
import { gracefulExit } from "../../lib/utils/exit";
import { findProjectRoot } from "../../lib/utils/project-root";

export const doctor = new Command("doctor")
  .description("Check osgrep health and paths")
  .action(async () => {
    console.log("🏥 osgrep Doctor\n");

    const root = PATHS.globalRoot;
    const grammars = PATHS.grammars;

    const checkDir = (name: string, p: string) => {
      const exists = fs.existsSync(p);
      const symbol = exists ? "✅" : "❌";
      console.log(`${symbol} ${name}: ${p}`);
    };

    checkDir("Root", root);
    checkDir("Grammars", grammars);

    try {
      await initNative();
      console.log("✅ Native models initialized");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`❌ Native init failed: ${msg}`);
      console.log("   Try: osgrep setup");
    }

    console.log(`\nLocal Project: ${process.cwd()}`);
    const projectRoot = findProjectRoot(process.cwd());
    if (projectRoot) {
      console.log(`✅ Index found at: ${path.join(projectRoot, ".osgrep")}`);
    } else {
      console.log(
        `ℹ️  No index found in current directory (run 'osgrep index' to create one)`,
      );
    }

    console.log(
      `\nSystem: ${os.platform()} ${os.arch()} | Node: ${process.version}`,
    );
    console.log("\nIf you see ✅ everywhere, you are ready to search!");

    await gracefulExit();
  });
