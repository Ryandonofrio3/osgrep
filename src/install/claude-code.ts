import { exec } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";

const execAsync = promisify(exec);

const shell =
  process.env.SHELL ||
  (process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "/bin/sh");

async function installPlugin() {
  // Get the path to the installed package's plugin directory
  const pluginPath = path.join(__dirname, "..", "..", "plugins", "osgrep");

  console.log("Installing osgrep plugin for Claude Code...");
  console.log(`Plugin path: ${pluginPath}`);

  try {
    // Install the plugin from the local path
    const { stdout, stderr } = await execAsync(
      `claude plugin install "${pluginPath}"`,
      { shell, env: process.env },
    );

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    console.log("✅ Successfully installed the osgrep plugin for Claude Code");
    console.log("\nNext steps:");
    console.log("1. Restart Claude Code if it's running");
    console.log(
      "2. The plugin will automatically index your project when you open it",
    );
    console.log(
      "3. Claude will use osgrep for semantic code search automatically",
    );
    console.log(
      "4. You can also use `osgrep` commands directly in your terminal",
    );
  } catch (error) {
    console.error("❌ Error installing plugin:");
    console.error(error);
    console.error("\nTroubleshooting:");
    console.error("- Ensure you have Claude Code installed");
    console.error("- Try running: claude plugin list");
    console.error(
      "- Check the Claude Code documentation: https://code.claude.com/docs",
    );
    console.error(
      "- Make sure osgrep is installed globally: npm install -g osgrep",
    );
    process.exit(1);
  }
}

export const installClaudeCode = new Command("install-claude-code")
  .description("Install the Claude Code plugin")
  .action(async () => {
    await installPlugin();
    process.exit(0);
  });
