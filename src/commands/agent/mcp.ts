import * as fs from "node:fs";
import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Command } from "commander";
import { initialSync } from "../../lib/index/syncer";
import { ensureSetup } from "../../lib/setup/setup-helpers";
import { ensureProjectPaths, findProjectRoot } from "../../lib/utils/project-root";

export const mcp = new Command("mcp")
  .description("Start MCP server for osgrep")
  .action(async (_optsArg, _cmd) => {
    process.on("SIGINT", () => {
      console.error("Received SIGINT, shutting down gracefully...");
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.error("Received SIGTERM, shutting down gracefully...");
      process.exit(0);
    });

    // Prevent unhandled promise rejections from crashing the MCP server
    process.on("unhandledRejection", (reason, promise) => {
      console.error(
        "[ERROR] Unhandled Rejection at:",
        promise,
        "reason:",
        reason,
      );
    });

    // The MCP server is writing to stdout, so all logs are written to stderr
    console.log = (...args: unknown[]) => {
      process.stderr.write(`[LOG] ${args.join(" ")}\n`);
    };

    console.error = (...args: unknown[]) => {
      process.stderr.write(`[ERROR] ${args.join(" ")}\n`);
    };

    console.debug = (..._args: unknown[]) => {
      // process.stderr.write(`[DEBUG] ${args.join(" ")}\n`);
    };

    const transport = new StdioServerTransport();
    const server = new Server(
      {
        name: "osgrep",
        version: JSON.parse(
          fs.readFileSync(path.join(__dirname, "../../package.json"), {
            encoding: "utf-8",
          }),
        ).version,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (_request) => {
      return {
        content: [{ type: "text", text: "Not implemented" }],
        isError: true,
      };
    });

    await server.connect(transport);

    const startBackgroundSync = async () => {
      console.log("[SYNC] Scheduling initial sync in 1 second...");

      setTimeout(async () => {
        console.log("[SYNC] Starting file sync...");
        try {
          const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
          ensureProjectPaths(projectRoot);
          process.env.OSGREP_PROJECT_ROOT = projectRoot;

          await ensureSetup();
          // We run initialSync. It will handle updates if already indexed,
          // essentially acting as a refresh on start.
          // Since osgrep serves as a "daemon" here, this keeps the index fresh on boot.
          await initialSync({
            projectRoot,
            dryRun: false,
            // We can pass a progress handler that logs to stderr if we want,
            // but for now let's keep it quiet or rely on the redirected console.log
          });
          console.log("[SYNC] Sync complete.");
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error("[SYNC] Sync failed:", errorMessage);
        }
      }, 1000);
    };

    startBackgroundSync().catch((error) => {
      console.error("[SYNC] Background sync setup failed:", error);
    });
  });
