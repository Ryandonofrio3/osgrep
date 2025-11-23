import { spawn } from "node:child_process";
import { Command } from "commander";

function runClaudeCommand(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["plugin", ...args], {
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`claude exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

async function installPlugin() {
  try {
    await runClaudeCommand(["marketplace", "add", "Ryandonofrio3/osgrep"]);
    console.log("✅ Successfully added the osgrep marketplace");
    await runClaudeCommand(["install", "osgrep"]);
    console.log("✅ Successfully installed the osgrep plugin for Claude Code");
    console.log("\nNext steps:");
    console.log("1. Restart Claude Code if it's running");
    console.log(
      "2. The plugin will automatically index your project when you open it",
    );
    console.log(
      "3. Claude will use osgrep for semantic code search automatically",
    );
    console.log("4. You can also use `osgrep` commands directly in your terminal");
  } catch (error) {
    console.error("❌ Error installing plugin:");
    console.error(error);
    console.error("\nTroubleshooting:");
    console.error(
      "- Ensure you have Claude Code version 2.0.36 or higher installed",
    );
    console.error("- Try running: claude plugin marketplace list");
    console.error(
      "- Check the Claude Code documentation: https://code.claude.com/docs",
    );
    process.exit(1);
  }
}

export const installClaudeCode = new Command("install-claude-code")
  .description("Install the Claude Code plugin")
  .action(async () => {
    await installPlugin();
  });
