import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import { Command } from "commander";
import { PATHS } from "../config";
import { ensureGrammars } from "../lib/index/grammar-loader";
import { DEFAULT_IGNORE_PATTERNS } from "../lib/index/ignore-patterns";
import type { InitialSyncProgress } from "../lib/index/sync-helpers";
import { initialSync } from "../lib/index/syncer";
import { GraphBuilder } from "../lib/graph/graph-builder";
import { Searcher } from "../lib/search/searcher";
import type { ExpandOptions } from "../lib/search/expansion-types";
import type { MetaEntry } from "../lib/store/meta-cache";
import { MetaCache } from "../lib/store/meta-cache";
import type { VectorRecord } from "../lib/store/types";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { isIndexableFile } from "../lib/utils/file-utils";
import { acquireWriterLockWithRetry } from "../lib/utils/lock";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  getServerForProject,
  isProcessRunning,
  listServers,
  registerServer,
  unregisterServer,
} from "../lib/utils/server-registry";
import { processFile } from "../lib/workers/orchestrator";

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
    let port = parseInt(options.port, 10);
    const startPort = port;
    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();

    // Check if already running
    const existing = getServerForProject(projectRoot);
    if (
      existing &&
      existing.pid !== process.pid &&
      isProcessRunning(existing.pid)
    ) {
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

      // Ensure the spawned server can be discovered/stopped immediately (even
      // before it finishes indexing and starts listening).
      if (typeof child.pid === "number") {
        registerServer({
          pid: child.pid,
          port: 0,
          projectRoot,
          startTime: Date.now(),
        });
      }

      console.log(`Started background server (PID: ${child.pid})`);
      return;
    }

    const paths = ensureProjectPaths(projectRoot);

    // Propagate project root to worker processes
    process.env.OSGREP_PROJECT_ROOT = projectRoot;

    // Register early to prevent race conditions where multiple sessions
    // spawn servers before any finishes indexing. Port 0 = "starting up".
    registerServer({
      pid: process.pid,
      port: 0,
      projectRoot,
      startTime: Date.now(),
    });

    try {
      await ensureSetup();
      await ensureGrammars(console.log, { silent: true });

      const vectorDb = new VectorDB(paths.lancedbDir);
      const searcher = new Searcher(vectorDb);
      const metaCache = new MetaCache(paths.lmdbPath);

      // Serialize DB writes (and optionally searches) to avoid LanceDB contention.
      let dbWriteBarrier: Promise<void> = Promise.resolve();
      let isWriting = false;

      // Track initial sync state for HTTP endpoints
      let initialSyncState: {
        inProgress: boolean;
        filesProcessed: number;
        filesIndexed: number;
        totalFiles: number;
        currentFile: string;
      } = {
        inProgress: true,
        filesProcessed: 0,
        filesIndexed: 0,
        totalFiles: 0,
        currentFile: "Starting...",
      };

      // Live indexing: watch filesystem changes and incrementally update the index.
      // Enabled by default for `serve` (can disable with OSGREP_WATCH=0).
      const watchEnabled = process.env.OSGREP_WATCH !== "0";
      const watchVerbose = process.env.OSGREP_WATCH_VERBOSE === "1";
      const watchMode = (process.env.OSGREP_WATCH_MODE || "auto").toLowerCase();
      const watchDebounceMsRaw = Number.parseInt(
        process.env.OSGREP_WATCH_DEBOUNCE_MS || "",
        10,
      );
      const watchDebounceMs =
        Number.isFinite(watchDebounceMsRaw) && watchDebounceMsRaw >= 0
          ? watchDebounceMsRaw
          : 250;

      const pendingUpserts = new Set<string>();
      const pendingUnlinks = new Set<string>();
      let watchTimer: NodeJS.Timeout | undefined;
      let watcher: FSWatcher | null = null;
      let nativeWatcher: fs.FSWatcher | null = null;
      let didLogWatchFallback = false;

      const shouldIgnoreRelPath = (relPathRaw: string): boolean => {
        const rel = relPathRaw.split(path.sep).join("/");
        if (!rel || rel === "." || rel.startsWith("../")) return true;
        if (rel === ".git" || rel.startsWith(".git/")) return true;
        if (rel === ".osgrep" || rel.startsWith(".osgrep/")) return true;
        // Large/irrelevant directories (mirrors DEFAULT_IGNORE_PATTERNS intent).
        if (rel === "node_modules" || rel.startsWith("node_modules/")) return true;
        if (rel.includes("/node_modules/")) return true;
        if (rel === "dist" || rel.startsWith("dist/")) return true;
        if (rel.includes("/dist/")) return true;
        if (rel === "build" || rel.startsWith("build/")) return true;
        if (rel.includes("/build/")) return true;
        if (rel === "out" || rel.startsWith("out/")) return true;
        if (rel.includes("/out/")) return true;
        if (rel === "target" || rel.startsWith("target/")) return true;
        if (rel.includes("/target/")) return true;
        if (rel === "coverage" || rel.startsWith("coverage/")) return true;
        if (rel.includes("/coverage/")) return true;
        if (rel === "benchmark" || rel.startsWith("benchmark/")) return true;
        if (rel.includes("/benchmark/")) return true;
        if (rel === ".idea" || rel.startsWith(".idea/")) return true;
        if (rel === ".vscode" || rel.startsWith(".vscode/")) return true;
        if (rel.endsWith(".DS_Store")) return true;
        return false;
      };

      const scheduleFlush = () => {
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          void flushPending().catch((err) => {
            console.error("[serve] live index flush failed:", err);
          });
        }, watchDebounceMs);
      };

      const recordUpsert = (absPath: string) => {
        const rel = path.relative(projectRoot, absPath);
        if (shouldIgnoreRelPath(rel)) return;
        pendingUnlinks.delete(rel);
        pendingUpserts.add(rel);
        scheduleFlush();
      };

      const recordUnlink = (absPath: string) => {
        const rel = path.relative(projectRoot, absPath);
        if (shouldIgnoreRelPath(rel)) return;
        pendingUpserts.delete(rel);
        pendingUnlinks.add(rel);
        scheduleFlush();
      };

      const flushPending = async () => {
        if (!watchEnabled) return;
        if (pendingUpserts.size === 0 && pendingUnlinks.size === 0) return;

        const upserts = Array.from(pendingUpserts);
        const unlinks = Array.from(pendingUnlinks);
        pendingUpserts.clear();
        pendingUnlinks.clear();

        // Phase 1: prepare work outside the writer lock (hashing/embedding can be slow).
        type PreparedUpsert = {
          relPath: string;
          absPath: string;
          meta: MetaEntry;
          shouldDelete: boolean;
          vectorsCount: number;
          vectors?: VectorRecord[];
        };

        const prepared: PreparedUpsert[] = [];

        for (const relPath of upserts) {
          const absPath = path.join(projectRoot, relPath);
          try {
            const stats = await fs.promises.stat(absPath);
            if (!isIndexableFile(absPath, stats.size)) {
              // If it was previously indexed, treat as deletion; still store meta to avoid rework.
              prepared.push({
                relPath,
                absPath,
                meta: { hash: "", mtimeMs: stats.mtimeMs, size: stats.size },
                shouldDelete: true,
                vectorsCount: 0,
              });
              continue;
            }

            const cached = metaCache.get(relPath);
            if (
              cached &&
              cached.mtimeMs === stats.mtimeMs &&
              cached.size === stats.size
            ) {
              continue;
            }

            const result = await processFile({ path: relPath, absolutePath: absPath });

            prepared.push({
              relPath,
              absPath,
              meta: { hash: result.hash, mtimeMs: result.mtimeMs, size: result.size },
              shouldDelete: result.shouldDelete === true,
              vectorsCount: result.vectors.length,
              vectors: result.vectors,
            });
          } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT") {
              unlinks.push(relPath);
              continue;
            }
            console.error(`[serve] live index: failed to prepare ${relPath}:`, err);
          }
        }

        const plannedUnlinks = unlinks.length;
        const plannedUpserts = prepared.length;

        // Phase 2: apply updates under writer lock; serialize DB operations.
        const apply = async () => {
          let lock: { release: () => Promise<void> } | null = null;
          try {
            isWriting = true;
            lock = await acquireWriterLockWithRetry(paths.osgrepDir, {
              maxRetries: 2,
              retryDelayMs: 250,
            });

            if (unlinks.length > 0) {
              await vectorDb.deletePaths(unlinks);
              for (const relPath of unlinks) {
                metaCache.delete(relPath);
              }
            }

            for (const item of prepared) {
              // If the file changed again since we prepared, skip and let the next event handle it.
              try {
                const stats = await fs.promises.stat(item.absPath);
                if (
                  stats.mtimeMs !== item.meta.mtimeMs ||
                  stats.size !== item.meta.size
                ) {
                  pendingUpserts.add(item.relPath);
                  continue;
                }
              } catch (err) {
                const code = (err as NodeJS.ErrnoException)?.code;
                if (code === "ENOENT") {
                  pendingUnlinks.add(item.relPath);
                }
                continue;
              }

              await vectorDb.deletePaths([item.relPath]);
              if (!item.shouldDelete && item.vectorsCount > 0) {
                await vectorDb.insertBatch(item.vectors as VectorRecord[]);
              }
              metaCache.put(item.relPath, item.meta);
            }

            if (watchVerbose && (plannedUnlinks > 0 || plannedUpserts > 0)) {
              console.log(
                `[serve] live index applied: upserts=${plannedUpserts} unlinks=${plannedUnlinks}`,
              );
            }
          } finally {
            if (lock) await lock.release();
            isWriting = false;
          }
        };

        dbWriteBarrier = dbWriteBarrier.then(apply, apply);
        await dbWriteBarrier;

        // If we re-queued work due to races, schedule another pass.
        if (pendingUpserts.size > 0 || pendingUnlinks.size > 0) {
          scheduleFlush();
        }
      };

      if (watchEnabled) {
        const startChokidar = (mode: "chokidar" | "poll") => {
          const ignored: (string | RegExp)[] = [
            ...DEFAULT_IGNORE_PATTERNS,
            "**/.git/**",
            "**/.osgrep/**",
          ];

          watcher = chokidar.watch(projectRoot, {
            ignored,
            ignoreInitial: true,
            persistent: true,
            usePolling: mode === "poll",
            interval: mode === "poll" ? 1000 : undefined,
            awaitWriteFinish: {
              stabilityThreshold: 200,
              pollInterval: 100,
            },
          });

          watcher.on("add", recordUpsert);
          watcher.on("change", recordUpsert);
          watcher.on("unlink", recordUnlink);
          watcher.on("error", async (err) => {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === "EMFILE" && mode !== "poll") {
              if (!didLogWatchFallback) {
                didLogWatchFallback = true;
                console.error(
                  "[serve] watcher hit EMFILE; falling back to polling mode (set OSGREP_WATCH_MODE=poll to force).",
                );
              }
              try {
                await watcher?.close();
              } catch {}
              watcher = null;
              startChokidar("poll");
              return;
            }
            console.error("[serve] watcher error:", err);
          });
        };

        const startNative = () => {
          nativeWatcher = fs.watch(
            projectRoot,
            { recursive: true },
            (eventType, filename) => {
              const name =
                typeof filename === "string"
                  ? filename
                  : typeof (filename as any)?.toString === "function"
                    ? String((filename as any).toString("utf-8"))
                    : "";
              if (!name) return;
              const rel = name.split(path.sep).join("/");
              if (shouldIgnoreRelPath(rel)) return;
              const absPath = path.join(projectRoot, name);
              // "rename" can be add/unlink/move; stat in flush determines outcome.
              if (eventType === "rename" || eventType === "change") {
                recordUpsert(absPath);
              }
            },
          );
          nativeWatcher.on("error", (err) => {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === "EMFILE") {
              if (!didLogWatchFallback) {
                didLogWatchFallback = true;
                console.error(
                  "[serve] native watcher hit EMFILE; falling back to polling mode (set OSGREP_WATCH_MODE=poll to force).",
                );
              }
              try {
                nativeWatcher?.close();
              } catch {}
              nativeWatcher = null;
              startChokidar("poll");
              return;
            }
            console.error("[serve] native watcher error:", err);
          });
        };

        if (watchMode === "off") {
          // noop
        } else if (watchMode === "native") {
          startNative();
        } else if (watchMode === "poll") {
          startChokidar("poll");
        } else if (watchMode === "chokidar") {
          startChokidar("chokidar");
        } else {
          // auto
          if (process.platform === "darwin" || process.platform === "win32") {
            startNative();
          } else {
            startChokidar("chokidar");
          }
        }
      }

      // Helper to run initial sync after server is listening
      const runInitialSync = async () => {
        const onProgress = (info: InitialSyncProgress) => {
          initialSyncState.filesProcessed = info.processed;
          initialSyncState.filesIndexed = info.indexed;
          initialSyncState.totalFiles = info.total;
          initialSyncState.currentFile = info.filePath ?? "";
        };

        try {
          await initialSync({ projectRoot, onProgress });
          await vectorDb.createFTSIndex();
          initialSyncState.inProgress = false;
          initialSyncState.currentFile = "";

          if (!process.env.OSGREP_BACKGROUND) {
            console.log("Initial index ready.");
          }
        } catch (e) {
          console.error("Initial sync failed:", e);
          // Mark as done but leave currentFile as error indicator
          initialSyncState.inProgress = false;
          initialSyncState.currentFile = "sync_failed";
        }
      };

      const server = http.createServer(async (req, res) => {
        try {
          if (req.method === "GET" && req.url === "/health") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                status: initialSyncState.inProgress ? "initializing" : "ok",
                initialSync: initialSyncState.inProgress
                  ? {
                      inProgress: true,
                      filesProcessed: initialSyncState.filesProcessed,
                      filesIndexed: initialSyncState.filesIndexed,
                      totalFiles: initialSyncState.totalFiles,
                      currentFile: initialSyncState.currentFile,
                    }
                  : null,
                indexing: isWriting,
                watch: watchEnabled,
              }),
            );
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

                // Add AbortController for cancellation
                const ac = new AbortController();
                req.on("aborted", () => {
                  ac.abort();
                });
                res.on("close", () => {
                  if (!res.writableEnded) ac.abort();
                });

                const timeoutMsRaw = Number.parseInt(
                  process.env.OSGREP_SERVER_SEARCH_TIMEOUT_MS || "",
                  10,
                );
                const timeoutMs =
                  Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
                    ? timeoutMsRaw
                    : 60000;
                let timeout: NodeJS.Timeout | undefined;

                try {
                  timeout = setTimeout(() => {
                    ac.abort();
                    if (!res.headersSent && !res.writableEnded) {
                      res.statusCode = 504;
                      res.setHeader("Content-Type", "application/json");
                      res.end(JSON.stringify({ error: "search_timeout" }));
                    }
                  }, timeoutMs);

                  // Parse deep option from request body
                  let expandOpts: ExpandOptions | undefined;
                  if (body.deep === true) {
                    expandOpts = {
                      maxDepth: 2,
                      maxExpanded: 20,
                      maxTokens: 0,
                      strategies: ["callers", "symbols"],
                    };
                  }

                  const debug = process.env.DEBUG_SERVER === "1";
                  if (debug) {
                    console.log(
                      `[serve] Starting search for "${query}", indexing=${isWriting} signal.aborted=${ac.signal.aborted}${
                        expandOpts ? " deep=true" : ""
                      }`,
                    );
                  }

                  const result = await searcher.search(
                    query,
                    limit,
                    { rerank: true },
                    undefined,
                    searchPath,
                    ac.signal,
                  );
                  if (debug) {
                    console.log(
                      `[serve] Search completed, ${result.data.length} results`,
                    );
                  }

                  if (ac.signal.aborted) {
                    console.log("[serve] Signal aborted after search");
                    return;
                  }

                  // Expand results if requested
                  let expanded;
                  if (expandOpts && result.data.length > 0) {
                    if (debug) {
                      console.log(`[serve] Expanding results with depth=${expandOpts.maxDepth}`);
                    }
                    expanded = await searcher.expand(result.data, query, expandOpts);
                    if (debug) {
                      console.log(
                        `[serve] Expansion completed, ${expanded.expanded.length} expanded chunks`,
                      );
                    }
                  }

                  res.statusCode = 200;
                  res.setHeader("Content-Type", "application/json");
                  const response: {
                    results: typeof result.data;
                    partial?: boolean;
                    initialSync?: {
                      filesProcessed: number;
                      filesIndexed: number;
                      totalFiles: number;
                    };
                    expanded?: typeof expanded;
                  } = { results: result.data };

                  if (initialSyncState.inProgress) {
                    response.partial = true;
                    response.initialSync = {
                      filesProcessed: initialSyncState.filesProcessed,
                      filesIndexed: initialSyncState.filesIndexed,
                      totalFiles: initialSyncState.totalFiles,
                    };
                  }

                  if (expanded) {
                    response.expanded = expanded;
                  }

                  res.end(JSON.stringify(response));
                } finally {
                  if (timeout) clearTimeout(timeout);
                }
              } catch (err) {
                console.log(`[serve] Search error: ${err instanceof Error ? err.name + ': ' + err.message : err}`);
                if (err instanceof Error && err.name === "AbortError") {
                  if (!res.headersSent && !res.writableEnded) {
                    res.statusCode = 504;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ error: "search_cancelled" }));
                  }
                  return;
                }
                if (isWriting && !res.headersSent && !res.writableEnded) {
                  res.statusCode = 503;
                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify({ error: "indexing_in_progress" }));
                  return;
                }
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

          if (req.method === "POST" && req.url === "/trace") {
            const chunks: Buffer[] = [];
            let totalSize = 0;
            let aborted = false;

            req.on("data", (chunk) => {
              if (aborted) return;
              totalSize += chunk.length;
              if (totalSize > 100_000) {
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
                const symbol = typeof body.symbol === "string" ? body.symbol : "";

                if (!symbol) {
                  res.statusCode = 400;
                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify({ error: "symbol_required" }));
                  return;
                }

                const graphBuilder = new GraphBuilder(vectorDb);
                const graph = await graphBuilder.buildGraph(symbol, {
                  depth: typeof body.depth === "number" ? body.depth : 1,
                  callersOnly: body.callers === true,
                  calleesOnly: body.callees === true,
                  pathPrefix: typeof body.path === "string" ? body.path : undefined,
                });

                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({
                  symbol,
                  center: graph.center
                    ? {
                        file: graph.center.file,
                        line: graph.center.line,
                        role: graph.center.role,
                      }
                    : null,
                  callers: graph.callers.map((c) => ({
                    symbol: c.symbol,
                    file: c.file,
                    line: c.line,
                  })),
                  callees: graph.callees,
                }));
              } catch (err) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(
                  JSON.stringify({
                    error: (err as Error)?.message || "trace_failed",
                  }),
                );
              }
            });

            req.on("error", (err) => {
              console.error("[serve] trace request error:", err);
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

      server.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE") {
          const nextPort = port + 1;
          if (nextPort < startPort + 10) {
            console.log(`Port ${port} in use, retrying with ${nextPort}...`);
            port = nextPort;
            server.close(() => {
              server.listen(port);
            });
            return;
          }
          console.error(
            `Could not find an open port between ${startPort} and ${startPort + 9}`,
          );
        }
        console.error("[serve] server error:", e);
        // Ensure we exit if server fails to start
        process.exit(1);
      });

      server.listen(port, () => {
        const address = server.address();
        const actualPort =
          typeof address === "object" && address ? address.port : port;

        if (!process.env.OSGREP_BACKGROUND) {
          console.log(
            `osgrep server listening on http://localhost:${actualPort} (${projectRoot})`,
          );
          console.log("Starting initial index...");
        }
        registerServer({
          pid: process.pid,
          port: actualPort,
          projectRoot,
          startTime: Date.now(),
        });

        // Start initial sync after server is listening (non-blocking)
        runInitialSync().catch((err) => {
          console.error("Initial sync error:", err);
        });
      });

      const shutdown = async () => {
        unregisterServer(process.pid);

        if (watchTimer) {
          clearTimeout(watchTimer);
          watchTimer = undefined;
        }
        try {
          await watcher?.close();
        } catch {}
        try {
          nativeWatcher?.close();
        } catch {}
        nativeWatcher = null

        // Properly await server close
        await new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) {
              console.error("Error closing server:", err);
              reject(err);
            } else {
              resolve();
            }
          });
          // Timeout fallback in case close hangs
          setTimeout(resolve, 5000);
        });

        // Clean close of vectorDB
        try {
          await vectorDb.close();
        } catch (e) {
          console.error("Error closing vector DB:", e);
        }
        try {
          metaCache.close();
        } catch {}
        await gracefulExit();
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (error) {
      unregisterServer(process.pid);
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
  .action(async (options) => {
    const waitForExit = async (pid: number, timeoutMs: number) => {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (Date.now() < deadline) {
        if (!isProcessRunning(pid)) return true;
        await new Promise((r) => setTimeout(r, 75));
      }
      return !isProcessRunning(pid);
    };

    const stopPid = async (pid: number): Promise<boolean> => {
      try {
        // If the process is stopped (job control), SIGTERM won't be handled until resumed.
        process.kill(pid, "SIGCONT");
      } catch {}

      try {
        process.kill(pid, "SIGTERM");
      } catch (e) {
        unregisterServer(pid);
        return false;
      }

      const exited = await waitForExit(pid, 2000);
      if (exited) {
        unregisterServer(pid);
        return true;
      }

      try {
        process.kill(pid, "SIGKILL");
      } catch (e) {
        unregisterServer(pid);
        return false;
      }

      const killed = await waitForExit(pid, 2000);
      unregisterServer(pid);
      return killed;
    };

    if (options.all) {
      const servers = listServers();
      let count = 0;
      for (const s of servers) {
        const ok = await stopPid(s.pid);
        if (ok) count++;
        else console.error(`Failed to stop PID ${s.pid}`);
      }
      console.log(`Stopped ${count} servers.`);
    } else {
      const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
      const server = getServerForProject(projectRoot);
      if (server) {
        const ok = await stopPid(server.pid);
        if (ok) {
          console.log(
            `Stopped server for ${projectRoot} (PID: ${server.pid})`,
          );
        } else {
          console.error(`Failed to stop PID ${server.pid}`);
        }
      } else {
        console.log(`No server found for ${projectRoot}`);
      }
    }
  });
