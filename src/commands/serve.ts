import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import chokidar, { type FSWatcher } from "chokidar";
import { createFileSystem, createStore } from "../lib/context";
import { ensureSetup } from "../lib/setup-helpers";
import { ensureStoreExists, isStoreEmpty } from "../lib/store-helpers";
import { resolveStoreIdWithWorktree } from "../lib/store-resolver";
import { createGit } from "../lib/context";
import type { Store } from "../lib/store";
import { DEFAULT_IGNORE_PATTERNS } from "../lib/ignore-patterns"
import {
  clearServerLock,
  computeBufferHash,
  debounce,
  formatDenseSnippet,
  indexFile,
  initialSync,
  isIndexablePath,
  MetaStore,
  preparedChunksToVectors,
  readServerLock,
  writeServerLock,
} from "../utils";

type PendingAction = "upsert" | "delete";

// Global State for the Server
let indexState = {
  isIndexing: false,
  indexed: 0,
  processed: 0,
  total: 0,
};

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

// Memory monitoring configuration
const MEMORY_CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds
const MEMORY_WARNING_THRESHOLD_MB = Number.parseInt(
  process.env.OSGREP_MEMORY_WARNING_MB ||
  String(Math.floor((os.totalmem() / 1024 / 1024) * 0.6)), // 60% of system RAM
  10
);
const MEMORY_RESTART_THRESHOLD_MB = Number.parseInt(
  process.env.OSGREP_MEMORY_RESTART_MB ||
  String(Math.floor((os.totalmem() / 1024 / 1024) * 0.75)), // 75% of system RAM
  10
);

function toDenseResults(
  storeRoot: string,
  data: Array<{
    score: number;
    text?: string | null;
    metadata?: Record<string, unknown>;
    generated_metadata?: { start_line?: number | null; type?: string | null };
  }>,
) {
  const root = path.resolve(storeRoot);
  return data.map((item) => {
    const rawPath =
      typeof item.metadata?.path === "string"
        ? (item.metadata.path as string)
        : "";
    const relPath = rawPath ? path.relative(root, rawPath) || rawPath : "unknown";
    const snippet = formatDenseSnippet(item.text ?? "");
    return {
      path: relPath,
      score: Number(item.score.toFixed(3)),
      content: snippet,
      chunk_type: item.generated_metadata?.type ?? undefined,
    };
  });
}

async function createWatcher(
  store: Store,
  storeId: string,
  root: string,
  metaStore: MetaStore,
): Promise<FSWatcher> {
  const fileSystem = createFileSystem({
    ignorePatterns: [...DEFAULT_IGNORE_PATTERNS, ".osgrep/**"],
  });

  fileSystem.loadOsgrepignore(root);

  const pending = new Map<string, PendingAction>();

  const processPending = debounce(async () => {
    const actions = Array.from(pending.entries());
    pending.clear();
    for (const [filePath, action] of actions) {
      if (action === "delete") {
        try {
          await store.deleteFile(storeId, filePath);
          metaStore.delete(filePath);
          await metaStore.save();
        } catch (err) {
          console.error("Failed to delete file from store:", err);
        }
        continue;
      }

      if (
        fileSystem.isIgnored(filePath, root) ||
        !isIndexablePath(filePath)
      ) {
        continue;
      }

      try {
        const buffer = await fs.promises.readFile(filePath);
        if (buffer.length === 0) continue;
        const hash = computeBufferHash(buffer);
        const { chunks, indexed: didIndex } = await indexFile(
          store,
          storeId,
          filePath,
          path.basename(filePath),
          metaStore,
          undefined,
          buffer,
          hash,
        );
        if (didIndex) {
          if (chunks.length > 0) {
            const vectors = await preparedChunksToVectors(chunks);
            await store.insertBatch(storeId, vectors);
          }
          metaStore.set(filePath, hash);
          await metaStore.save();
        }
      } catch (err) {
        console.error("Failed to index changed file:", err);
      }
    }
  }, 300);

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    ignored: (watchedPath) =>
      fileSystem.isIgnored(watchedPath.toString(), root) ||
      watchedPath.toString().includes(`${path.sep}.git${path.sep}`) ||
      watchedPath.toString().includes(`${path.sep}.osgrep${path.sep}`),
  });

  watcher
    .on("add", (filePath) => {
      pending.set(path.resolve(filePath), "upsert");
      processPending();
    })
    .on("change", (filePath) => {
      pending.set(path.resolve(filePath), "upsert");
      processPending();
    })
    .on("unlink", (filePath) => {
      pending.set(path.resolve(filePath), "delete");
      processPending();
    });

  return watcher;
}

async function respondJson(
  res: http.ServerResponse,
  status: number,
  payload: object,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export const serve = new Command("serve")
  .description("Run osgrep as a background server with live indexing")
  .option("-p, --port <port>", "Port to listen on", process.env.OSGREP_PORT || "4444")
  .option("--parent-pid <pid>", "Parent process ID to watch for auto-shutdown")
  .action(async (_args, cmd) => {
    const options: { port: string; store?: string; parentPid?: string } = cmd.optsWithGlobals();
    const port = parseInt(options.port, 10);
    const parentPid = options.parentPid ? parseInt(options.parentPid, 10) : null;
    const authToken = randomUUID();

    // Resolve root to main repo if in a worktree
    let root = process.cwd();
    const git = createGit();
    if (git.isWorktree(root)) {
      const mainRoot = git.getMainRepoRoot(root);
      if (mainRoot) {
        root = mainRoot;
      }
    }

    let store: Store | null = null;
    let watcher: FSWatcher | null = null;
    let server: http.Server | null = null;
    const metaStore = new MetaStore();

    const shutdown = async () => {
      try {
        await clearServerLock(root);
      } catch (err) {
        console.error("Failed to clear server lock:", err);
      }
      try {
        await watcher?.close();
      } catch (err) {
        console.error("Failed to close watcher:", err);
      }
      if (store && typeof store.close === "function") {
        try {
          await store.close();
        } catch (err) {
          console.error("Failed to close store:", err);
        }
      }
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("exit", async () => {
      await clearServerLock(root);
    });

    if (parentPid && !Number.isNaN(parentPid)) {
      setInterval(() => {
        try {
          process.kill(parentPid, 0);
        } catch {
          console.log(`Parent process ${parentPid} died. Shutting down...`);
          shutdown();
        }
      }, 5000).unref();
    }

    // Memory monitoring: Check every 30 seconds and gracefully restart if needed
    let lastMemoryWarning = 0;
    const memoryMonitor = setInterval(() => {
      const memUsage = process.memoryUsage();
      const rssMb = Math.round(memUsage.rss / 1024 / 1024);

      // Log warning if above warning threshold (but only once per 5 minutes)
      if (rssMb > MEMORY_WARNING_THRESHOLD_MB) {
        const now = Date.now();
        if (now - lastMemoryWarning > 300_000) { // 5 minutes
          console.warn(
            `[osgrep serve] Memory usage high: ${rssMb}MB (warning threshold: ${MEMORY_WARNING_THRESHOLD_MB}MB)`
          );
          lastMemoryWarning = now;
        }
      }

      // Graceful restart if above restart threshold
      if (rssMb > MEMORY_RESTART_THRESHOLD_MB) {
        console.warn(
          `[osgrep serve] Memory limit exceeded: ${rssMb}MB > ${MEMORY_RESTART_THRESHOLD_MB}MB. Restarting gracefully...`
        );
        clearInterval(memoryMonitor);

        const restart = () => {
          // Spawn a new server process with the same port and parent PID
          const { spawn } = require("node:child_process");
          const args = ["serve", "--port", String(port)];
          if (parentPid) {
            args.push("--parent-pid", String(parentPid));
          }

          const child = spawn(process.execPath, [process.argv[1], ...args], {
            detached: true,
            stdio: "inherit",
          });
          child.unref();

          console.log(
            "[osgrep serve] New server started. Shutting down old instance..."
          );
          shutdown();
        };

        // Ensure we release the port before spawning the replacement
        if (server && typeof server.close === "function") {
          server.close(restart);
        } else {
          restart();
        }
      }
    }, MEMORY_CHECK_INTERVAL_MS).unref();

    try {
      await ensureSetup({ silent: true });
      await metaStore.load();
      store = await createStore();
      // Uses worktree-aware resolution to share index with main repo
      const storeId = options.store || resolveStoreIdWithWorktree(root);
      await ensureStoreExists(store, storeId);

      const empty = await isStoreEmpty(store, storeId);
      if (empty) {
        const fileSystem = createFileSystem({
          ignorePatterns: [...DEFAULT_IGNORE_PATTERNS, ".osgrep/**"],
        });
        console.log("Store empty, performing initial index (background)...");

        // Setup the Progress Callback
        const onProgress = (info: {
          processed: number;
          indexed: number;
          total: number;
        }) => {
          indexState = {
            isIndexing: info.indexed < info.total,
            indexed: info.indexed,
            processed: info.processed,
            total: info.total,
          };
        };

        // Trigger Sync (Non-blocking / Background)
        indexState.isIndexing = true;
        initialSync(
          store,
          fileSystem,
          storeId,
          root,
          false,
          onProgress,
          metaStore,
          undefined, // No timeout for server mode
        )
          .then(() => {
            indexState.isIndexing = false;
            console.log("Background indexing complete.");
          })
          .catch((err) => {
            indexState.isIndexing = false;
            console.error("Background index failed:", err);
          });
      } else {
        indexState.isIndexing = false;
      }

      watcher = await createWatcher(store, storeId, root, metaStore);

      server = http.createServer(async (req, res) => {
        const rawAuth =
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : Array.isArray(req.headers.authorization)
              ? req.headers.authorization[0]
              : undefined;
        const providedToken =
          rawAuth && rawAuth.startsWith("Bearer ")
            ? rawAuth.slice("Bearer ".length)
            : rawAuth;
        if (providedToken !== authToken) {
          return respondJson(res, 401, { error: "unauthorized" });
        }

        if (!req.url) {
          return respondJson(res, 400, { error: "Invalid request" });
        }

        const url = new URL(req.url, `http://localhost:${port}`);
        if (req.method === "GET" && url.pathname === "/health") {
          return respondJson(res, 200, { status: "ready" });
        }

        if (req.method === "POST" && url.pathname === "/search") {
          const contentLengthHeader = req.headers["content-length"];
          const declaredLength = Array.isArray(contentLengthHeader)
            ? parseInt(contentLengthHeader[0] ?? "", 10)
            : contentLengthHeader
              ? parseInt(contentLengthHeader, 10)
              : NaN;

          if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
            return respondJson(res, 413, { error: "payload_too_large" });
          }

          // Block until initial indexing is complete to prevent race conditions
          if (indexState.isIndexing) {
            // We can either wait or return 503. Waiting is better for UX but might timeout.
            // Let's wait up to 5 seconds, then return 503 if still indexing.
            const startWait = Date.now();
            while (indexState.isIndexing) {
              if (Date.now() - startWait > 5000) {
                return respondJson(res, 503, {
                  error: "indexing_in_progress",
                  message: "Initial indexing in progress. Please try again later.",
                  progress: Math.round((indexState.processed / indexState.total) * 100)
                });
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }

          let receivedBytes = 0;
          let rejected = false;
          const chunks: Buffer[] = [];
          req.on("data", (c) => {
            if (rejected) return;
            receivedBytes += c.length;
            if (receivedBytes > MAX_REQUEST_BYTES) {
              rejected = true;
              respondJson(res, 413, { error: "payload_too_large" });
              req.destroy();
              return;
            }
            chunks.push(c);
          });
          req.on("end", async () => {
            if (rejected) return;
            try {
              const bodyRaw = Buffer.concat(chunks).toString("utf-8");
              const body = bodyRaw ? JSON.parse(bodyRaw) : {};
              const query = typeof body.query === "string" ? body.query : "";
              if (!query) {
                return respondJson(res, 400, { error: "query is required" });
              }
              const limit =
                typeof body.limit === "number" && !Number.isNaN(body.limit)
                  ? body.limit
                  : 25;
              const rerank = body.rerank === false ? false : true;

              const searchPath = (() => {
                if (typeof body.path !== "string" || body.path.length === 0) {
                  return root;
                }
                const normalized = path.normalize(
                  path.isAbsolute(body.path) ? body.path : path.join(root, body.path),
                );
                const resolvedRoot = path.resolve(root);
                const resolvedPath = path.resolve(normalized);

                // Prevent path traversal
                if (
                  !resolvedPath.startsWith(resolvedRoot + path.sep) &&
                  resolvedPath !== resolvedRoot
                ) {
                  // If they try to escape, just clamp to root or throw.
                  // For security, let's treat it as root or throw an error.
                  // Throwing is safer/clearer that it was rejected.
                  throw new Error("Access denied: path outside repository root");
                }
                return resolvedPath;
              })();

              const filters =
                body.filters && typeof body.filters === "object"
                  ? body.filters
                  : {
                    all: [
                      {
                        key: "path",
                        operator: "starts_with",
                        value: searchPath,
                      },
                    ],
                  };

              const results = await store!.search(
                storeId,
                query,
                limit,
                { rerank },
                filters,
              );
              const dense = toDenseResults(root, results.data);

              // INJECT STATUS
              const responsePayload = {
                results: dense,
                status: indexState.isIndexing ? "indexing" : "ready",
                progress: indexState.isIndexing
                  ? Math.round((indexState.indexed / indexState.total) * 100)
                  : 100,
              };

              return respondJson(res, 200, responsePayload);
            } catch (err) {
              console.error("Search handler failed:", err);
              return respondJson(res, 500, { error: "search_failed" });
            }
          });
          return;
        }

        return respondJson(res, 404, { error: "not_found" });
      });

      server!.listen(port, "127.0.0.1", async () => {
        await writeServerLock(port, process.pid, root, authToken);
        const lock = await readServerLock(root);
        console.log(
          `osgrep serve listening on port ${port} (lock: ${lock?.pid ?? "n/a"})`,
        );
      });
    } catch (error) {
      console.error(
        "Failed to start osgrep server:",
        error instanceof Error ? error.message : "Unknown error",
      );
      await shutdown();
    }
  });
