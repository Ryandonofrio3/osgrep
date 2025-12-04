import * as http from "node:http";
import * as path from "node:path";
import { Command } from "commander";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { ensureGrammars } from "../lib/index/grammar-loader";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { gracefulExit } from "../lib/utils/exit";
import { VectorDB } from "../lib/store/vector-db";
import { Searcher } from "../lib/search/searcher";
import { initialSync } from "../lib/index/syncer";
import { createIndexingSpinner } from "../lib/index/sync-helpers";

export const serve = new Command("serve")
  .description("Run osgrep as a background server with live indexing")
  .option("-p, --port <port>", "Port to listen on", process.env.OSGREP_PORT || "4444")
  .action(async (_args, cmd) => {
    const options: { port: string } = cmd.optsWithGlobals();
    const port = parseInt(options.port, 10);
    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
    const paths = ensureProjectPaths(projectRoot);

    try {
      await ensureSetup();
      await ensureGrammars(console.log, { silent: true });

      const vectorDb = new VectorDB(paths.lancedbDir);
      const searcher = new Searcher(vectorDb);

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
                const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {};
                const query = typeof body.query === "string" ? body.query : "";
                const limit = typeof body.limit === "number" ? body.limit : 10;

                let searchPath = "";
                if (typeof body.path === "string") {
                  const resolvedPath = path.resolve(projectRoot, body.path);
                  const rootPrefix = projectRoot.endsWith(path.sep)
                    ? projectRoot
                    : `${projectRoot}${path.sep}`;
                  if (
                    resolvedPath !== projectRoot &&
                    !resolvedPath.startsWith(rootPrefix)
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
                res.end(JSON.stringify({ error: (err as Error)?.message || "search_failed" }));
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
        console.log(`osgrep server listening on http://localhost:${port} (${projectRoot})`);
      });
      server.on("error", (err) => {
        console.error("[serve] server error:", err);
      });

      const shutdown = async () => {
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
