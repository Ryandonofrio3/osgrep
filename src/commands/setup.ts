import * as fs from "node:fs";
import { Command } from "commander";
import { PATHS } from "../config";
import { ensureGrammars } from "../lib/index/grammar-loader";
import { initNative } from "../lib/native";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { gracefulExit } from "../lib/utils/exit";

export const setup = new Command("setup")
  .description("One-time setup: download models and prepare osgrep")
  .action(async () => {
    console.log("osgrep Setup\n");

    try {
      await ensureSetup();
    } catch (error) {
      console.error("Setup failed:", error);
      process.exit(1);
    }

    // Show final status
    console.log("\nSetup Complete!\n");

    const checkDir = (name: string, p: string) => {
      const exists = fs.existsSync(p);
      const symbol = exists ? "✓" : "✗";
      console.log(`${symbol} ${name}: ${p}`);
    };

    checkDir("Global Root", PATHS.globalRoot);
    checkDir("Grammars", PATHS.grammars);

    // Download Grammars
    console.log("\nChecking Tree-sitter Grammars...");
    await ensureGrammars();

    // Pre-warm native models (downloads via HuggingFace Hub cache on first run)
    console.log("\nInitializing native models...");
    await initNative();
    console.log("✓ Native models ready");

    console.log(`\nosgrep is ready! You can now run:`);
    console.log(`   osgrep index              # Index your repository`);
    console.log(`   osgrep "search query"     # Search your code`);
    console.log(`   osgrep doctor             # Check health status`);

    await gracefulExit();
  });
