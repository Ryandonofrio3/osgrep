import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { Command } from "commander";
import { PATHS } from "../config";
import { ensureGrammars } from "../lib/index/grammar-loader";
import { createIndexingSpinner } from "../lib/index/sync-helpers";
import { initialSync } from "../lib/index/syncer";
import { Searcher } from "../lib/search/searcher";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  getServerForProject,
  isProcessRunning,
  listServers,
  registerServer,
  unregisterServer,
} from "../lib/utils/server-registry";

export const serve = new Command("serve")
  .description("Run osgrep as a background server with live indexing")
  .option(
    "-p, --port <port>",
    "Port to listen on",
    process.env.OSGREP_PORT || "4444",
  )
  .option("-b, --background", "Run in background", false)
  .action(async (_args, cmd) => {
    const options: { port: string; background: boolean } =
      cmd.optsWithGlobals();
    const port = parseInt(options.port, 10);
    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();

    // Check if already running
    const existing = getServerForProject(projectRoot);
    if (existing && isProcessRunning(existing.pid)) {
      console.log(
        `Server already running for ${projectRoot} (PID: ${existing.pid}, Port: ${existing.port})`,
      );
      return;
    }

    if (options.background) {
      const args = process.argv
        .slice(2)
        .filter((arg) => arg !== "-b" && arg !== "--background");
      const logDir = path.join(PATHS.globalRoot, "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, "server.log");
      const out = fs.openSync(logFile, "a");
      const err = fs.openSync(logFile, "a");

      const child = spawn(process.argv[0], [process.argv[1], ...args], {
        detached: true,
        stdio: ["ignore", out, err],
        cwd: process.cwd(),
        env: { ...process.env, OSGREP_BACKGROUND: "true" },
      });
      child.unref();
      console.log(`Started background server (PID: ${child.pid})`);
      return;
    }

    const paths = ensureProjectPaths(projectRoot);

    try {
      await ensureSetup();
      await ensureGrammars(console.log, { silent: true });

      const vectorDb = new VectorDB(paths.lancedbDir);
      const searcher = new Searcher(vectorDb);

      // Only show spinner if not in background (or check isTTY)
      // If spawned in background with stdio ignore, console.log goes nowhere.
      // But we might want to log to a file in the future.

      if (!process.env.OSGREP_BACKGROUND) {
        const { spinner, onProgress } = createIndexingSpinner(
          projectRoot,
          "Indexing before starting server...",
        );
        try {
          await initialSync({
            projectRoot,
            onProgress,
          });
          await vectorDb.createFTSIndex();
          spinner.succeed("Initial index ready. Starting server...");
        } catch (e) {
          spinner.fail("Indexing failed");
          throw e;
        }
      } else {
        // In background, just sync quietly
        await initialSync({ projectRoot });
        await vectorDb.createFTSIndex();
      }

      const server = http.createServer(async (req, res) => {
        try {
          if (req.method === "GET" && req.url === "/health") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }

          if (req.method === "POST" && req.url === "/search") {
            const chunks: Buffer[] = [];
            let totalSize = 0;
            let aborted = false;

            req.on("data", (chunk) => {
              if (aborted) return;
              totalSize += chunk.length;
              if (totalSize > 1_000_000) {
                aborted = true;
                res.statusCode = 413;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "payload_too_large" }));
                req.destroy();
                return;
              }
              chunks.push(chunk);
            });

            req.on("end", async () => {
              if (aborted) return;
              try {
                const body = chunks.length
                  ? JSON.parse(Buffer.concat(chunks).toString("utf-8"))
                  : {};
                const query = typeof body.query === "string" ? body.query : "";
                const limit = typeof body.limit === "number" ? body.limit : 10;

                let searchPath = "";
                if (typeof body.path === "string") {
                  const resolvedPath = path.resolve(projectRoot, body.path);
                  const rootPrefix = projectRoot.endsWith(path.sep)
                    ? projectRoot
                    : `${projectRoot}${path.sep}`;

                  // Normalize paths for consistency (Windows/Linux)
                  const normalizedRootPrefix = path.normalize(rootPrefix);
                  const normalizedResolvedPath = path.normalize(resolvedPath);

                  if (
                    normalizedResolvedPath !== projectRoot &&
                    !normalizedResolvedPath.startsWith(normalizedRootPrefix)
                  ) {
                    res.statusCode = 400;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ error: "invalid_path" }));
                    return;
                  }
                  searchPath = path.relative(projectRoot, resolvedPath);
                }

                const result = await searcher.search(
                  query,
                  limit,
                  { rerank: true },
                  undefined,
                  searchPath,
                );

                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ results: result.data }));
              } catch (err) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(
                  JSON.stringify({
                    error: (err as Error)?.message || "search_failed",
                  }),
                );
              }
            });

            req.on("error", (err) => {
              console.error("[serve] request error:", err);
              aborted = true;
            });

            return;
          }

          res.statusCode = 404;
          res.end();
        } catch (err) {
          console.error("[serve] request handler error:", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "internal_error" }));
          }
        }
      });

      server.listen(port, () => {
        if (!process.env.OSGREP_BACKGROUND) {
          console.log(
            `osgrep server listening on http://localhost:${port} (${projectRoot})`,
          );
        }
        registerServer({
          pid: process.pid,
          port,
          projectRoot,
          startTime: Date.now(),
        });
      });
      server.on("error", (err) => {
        console.error("[serve] server error:", err);
      });

      const shutdown = async () => {
        unregisterServer(process.pid);
        server.close();
        // Clean close of vectorDB
        try {
          await vectorDb.close();
        } catch (e) {
          console.error("Error closing vector DB:", e);
        }
        await gracefulExit();
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Serve failed:", message);
      process.exitCode = 1;
      await gracefulExit(1);
    }
  });

serve
  .command("status")
  .description("Show status of background servers")
  .action(() => {
    const servers = listServers();
    if (servers.length === 0) {
      console.log("No running servers found.");
      return;
    }
    console.log("Running servers:");
    servers.forEach((s) => {
      console.log(`- PID: ${s.pid} | Port: ${s.port} | Root: ${s.projectRoot}`);
    });
  });

serve
  .command("stop")
  .description("Stop background servers")
  .option("--all", "Stop all servers", false)
  .action((options) => {
    if (options.all) {
      const servers = listServers();
      let count = 0;
      servers.forEach((s) => {
        try {
          process.kill(s.pid, "SIGTERM");
          count++;
        } catch (e) {
          console.error(`Failed to stop PID ${s.pid}:`, e);
        }
      });
      console.log(`Stopped ${count} servers.`);
    } else {
      const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
      const server = getServerForProject(projectRoot);
      if (server) {
        try {
          process.kill(server.pid, "SIGTERM");
          console.log(`Stopped server for ${projectRoot} (PID: ${server.pid})`);
        } catch (e) {
          console.error(`Failed to stop PID ${server.pid}:`, e);
        }
      } else {
        console.log(`No server found for ${projectRoot}`);
      }
    }
  });
