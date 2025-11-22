import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
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
      { shell, env: process.env }
    );
    
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    
    console.log("✅ Successfully installed the osgrep plugin for Claude Code");
    console.log("\nNext steps:");
    console.log("1. Restart Claude Code if it's running");
    console.log("2. The plugin will automatically start `osgrep watch` when you open a project");
    console.log("3. Use `osgrep` in your terminal or let Claude use it automatically");
  } catch (error) {
    console.error("❌ Error installing plugin:");
    console.error(error);
    console.error("\nTroubleshooting:");
    console.error("- Ensure you have claude-code version 2.0.36 or higher installed");
    console.error("- Try running: claude plugin list");
    console.error("- Check the Claude Code documentation: https://docs.anthropic.com/claude/docs");
    process.exit(1);
  }
}

export const installClaudeCode = new Command("install-claude-code")
  .description("Install the Claude Code plugin")
  .action(async () => {
    await installPlugin();
  });
