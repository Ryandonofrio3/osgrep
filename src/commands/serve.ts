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
import { getAutoStoreId } from "../lib/store-resolver";
import type { Store } from "../lib/store";
import { DEFAULT_IGNORE_PATTERNS } from "../lib/ignore-patterns"
import { spawn } from "node:child_process";
import {
  clearServerLock,
  computeBufferHash,
  debounce,
  formatDenseSnippet,
  indexFile,
  initialSync,
  isIndexablePath,
  isProcessRunning,
  listAllServers,
  MetaStore,
  preparedChunksToVectors,
  readServerLock,
  registerServer,
  unregisterServer,
  verifyOsgrepServer,
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

const DEFAULT_PORT = 4444;
const MAX_PORT_RETRIES = 10;

/** Returns next available port by incrementing from highest registered server port. */
async function getNextAvailablePort(): Promise<number> {
  const servers = await listAllServers();
  if (servers.length === 0) {
    return DEFAULT_PORT;
  }
  const maxPort = Math.max(...servers.map((s) => s.port));
  return maxPort + 1;
}

/**
 * Attempts to bind a server to a port, retrying with incremented ports on EADDRINUSE.
 * Only retries if port was auto-assigned (not explicitly specified by user).
 */
function listenWithRetry(
  server: http.Server,
  initialPort: number,
  isAutoAssigned: boolean,
  onSuccess: (port: number) => void,
  onError: (error: Error) => void,
): void {
  let currentPort = initialPort;
  let retries = 0;

  const tryListen = () => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        if (!isAutoAssigned) {
          // Port was explicitly specified, don't retry
          onError(new Error(`Port ${currentPort} is already in use`));
          return;
        }

        if (retries >= MAX_PORT_RETRIES) {
          onError(new Error(`Failed to find available port after ${MAX_PORT_RETRIES} retries (tried ${initialPort}-${currentPort})`));
          return;
        }

        retries++;
        currentPort++;
        console.log(`Port ${currentPort - 1} in use, trying ${currentPort}...`);
        tryListen();
      } else {
        onError(err);
      }
    });

    server.listen(currentPort, "127.0.0.1", () => {
      onSuccess(currentPort);
    });
  };

  tryListen();
}

export const serve = new Command("serve")
  .description("Run osgrep as a background server with live indexing")
  .option("-p, --port <port>", "Port to listen on (auto-increments if not specified)")
  .option("-b, --background", "Run server in background and exit")
  .option("--parent-pid <pid>", "Parent process ID to watch for auto-shutdown")
  .action(async (_args, cmd) => {
    const options: { port?: string; store?: string; parentPid?: string; background?: boolean } = cmd.optsWithGlobals();
    const root = process.cwd();

    // Determine port: explicit > env > auto-increment from registry
    // Returns [port, isAutoAssigned] to enable retry logic on EADDRINUSE
    const resolvePort = async (): Promise<[number, boolean]> => {
      if (options.port) {
        return [parseInt(options.port, 10), false];
      }
      if (process.env.OSGREP_PORT) {
        return [parseInt(process.env.OSGREP_PORT, 10), false];
      }
      return [await getNextAvailablePort(), true];
    };

    // Handle background mode: spawn detached process and exit
    // For auto-assigned ports, we let the child process determine its own port with retry logic.
    // This prevents race conditions when multiple servers start simultaneously.
    if (options.background) {
      const [suggestedPort, isAutoAssigned] = await resolvePort();
      const args = ["serve"];

      // Only pass explicit port if user specified it (no retry on EADDRINUSE)
      // Auto-assigned ports let child retry with different ports if needed
      if (!isAutoAssigned) {
        args.push("-p", String(suggestedPort));
      }
      if (options.parentPid) {
        args.push("--parent-pid", options.parentPid);
      }

      const child = spawn(process.execPath, [process.argv[1], ...args], {
        detached: true,
        stdio: "ignore",
        cwd: root,
      });
      child.unref();

      // Wait for the server to start and verify it's responding
      const maxWaitMs = 10_000;
      const pollIntervalMs = 200;
      const startTime = Date.now();

      let verified = false;
      let actualPort: number | undefined;
      while (Date.now() - startTime < maxWaitMs) {
        // Check if lock file exists with auth token
        const lock = await readServerLock(root);
        // For auto-assigned ports, accept any port; for explicit ports, require exact match
        const portMatches = isAutoAssigned || lock?.port === suggestedPort;
        if (lock?.authToken && portMatches) {
          // Verify the server is actually responding
          const isRunning = await verifyOsgrepServer(lock.port, lock.authToken, 1000);
          if (isRunning) {
            verified = true;
            actualPort = lock.port;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      if (verified && actualPort) {
        console.log(`osgrep serve started in background on port ${actualPort} (pid: ${child.pid})`);
        process.exit(0);
      } else {
        const portInfo = isAutoAssigned ? "auto-assigned port" : `port ${suggestedPort}`;
        console.error(`Failed to start osgrep server on ${portInfo}. Server did not respond within ${maxWaitMs / 1000}s.`);
        // Try to clean up the child if it's still around
        try {
          if (child.pid) {
            process.kill(child.pid, "SIGTERM");
          }
        } catch {
          // Child may have already exited
        }
        process.exit(1);
      }
    }

    const [initialPort, isPortAutoAssigned] = await resolvePort();
    let port = initialPort; // May be updated by retry logic on EADDRINUSE
    const parentPid = options.parentPid ? parseInt(options.parentPid, 10) : null;
    const authToken = randomUUID();

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
        await unregisterServer(root);
      } catch (err) {
        console.error("Failed to unregister server:", err);
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
      const storeId = options.store || getAutoStoreId(root);
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

      listenWithRetry(
        server!,
        initialPort,
        isPortAutoAssigned,
        async (actualPort) => {
          port = actualPort; // Update port in case retry changed it
          await writeServerLock(port, process.pid, root, authToken);
          await registerServer({ cwd: root, port, pid: process.pid, authToken });
          const lock = await readServerLock(root);
          console.log(
            `osgrep serve listening on port ${port} (lock: ${lock?.pid ?? "n/a"})`,
          );
        },
        async (error) => {
          console.error(
            "Failed to start osgrep server:",
            error instanceof Error ? error.message : "Unknown error",
          );
          await shutdown();
        },
      );
    } catch (error) {
      console.error(
        "Failed to start osgrep server:",
        error instanceof Error ? error.message : "Unknown error",
      );
      await shutdown();
    }
  });

/** Subcommand: Stop osgrep server(s). Verifies PID ownership before killing. */
const stopCommand = new Command("stop")
  .description("Stop the osgrep server")
  .option("-a, --all", "Stop all running osgrep servers")
  .action(async (_args, cmd) => {
    const options: { all?: boolean } = cmd.optsWithGlobals();
    const root = process.cwd();

    if (options.all) {
      // Stop all servers
      const servers = await listAllServers();
      if (servers.length === 0) {
        console.log("No osgrep servers are running.");
        return;
      }

      let stopped = 0;
      let stale = 0;
      let skipped = 0;
      for (const entry of servers) {
        if (!isProcessRunning(entry.pid)) {
          stale++;
          // Clean up lock file and registry entry for non-running process
          try {
            await clearServerLock(entry.cwd);
          } catch (_err) {
            // Ignore errors cleaning up lock files
          }
          try {
            await unregisterServer(entry.cwd);
          } catch (_err) {
            // Ignore registry errors
          }
          continue;
        }

        // Verify this is actually an osgrep server before killing
        // This prevents accidentally killing unrelated processes if PIDs were reused
        const isOsgrep = await verifyOsgrepServer(entry.port, entry.authToken);
        if (!isOsgrep) {
          // Process exists but isn't our osgrep server - PID was likely reused
          console.warn(
            `Warning: PID ${entry.pid} exists but does not respond as osgrep server at ${entry.cwd}. ` +
            `Skipping kill to avoid terminating unrelated process. Cleaning up stale registry entry.`
          );
          skipped++;
          // Clean up stale lock file and registry entry
          try {
            await clearServerLock(entry.cwd);
          } catch (_err) {
            // Ignore errors cleaning up lock files
          }
          try {
            await unregisterServer(entry.cwd);
          } catch (_err) {
            // Ignore registry errors
          }
          continue;
        }

        try {
          process.kill(entry.pid, "SIGTERM");
          stopped++;
          console.log(`Stopped server at ${entry.cwd} (pid: ${entry.pid}, port: ${entry.port})`);
        } catch (err) {
          console.error(`Failed to stop server at ${entry.cwd}:`, err);
        }
        // Clean up lock file and registry entry
        try {
          await clearServerLock(entry.cwd);
        } catch (_err) {
          // Ignore errors cleaning up lock files
        }
        try {
          await unregisterServer(entry.cwd);
        } catch (_err) {
          // Ignore registry errors
        }
      }

      // Give servers time to clean up gracefully
      if (stopped > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (stopped > 0) {
        console.log(`\nStopped ${stopped} server(s).`);
      }
      if (stale > 0) {
        console.log(`Cleaned up ${stale} stale registry entry/entries.`);
      }
      if (skipped > 0) {
        console.log(`Skipped ${skipped} entry/entries with reused PIDs (not osgrep servers).`);
      }
    } else {
      // Stop server in current directory
      const lock = await readServerLock(root);
      if (!lock) {
        console.log("No osgrep server is running in this directory.");
        return;
      }

      if (!isProcessRunning(lock.pid)) {
        console.log(`Server lock exists but process (pid: ${lock.pid}) is not running. Cleaning up...`);
        await clearServerLock(root);
        await unregisterServer(root);
        console.log("Cleaned up stale server lock.");
        return;
      }

      // Verify this is actually an osgrep server before killing
      // This prevents accidentally killing unrelated processes if PIDs were reused
      const isOsgrep = await verifyOsgrepServer(lock.port, lock.authToken);
      if (!isOsgrep) {
        console.warn(
          `Warning: PID ${lock.pid} exists but does not respond as osgrep server. ` +
          `The PID may have been reused by another process. Cleaning up stale lock file.`
        );
        await clearServerLock(root);
        await unregisterServer(root);
        console.log("Cleaned up stale server lock without killing process.");
        return;
      }

      try {
        process.kill(lock.pid, "SIGTERM");
        console.log(`Stopped osgrep server (pid: ${lock.pid}, port: ${lock.port})`);

        // Give the server a moment to clean up gracefully
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Clean up if the server didn't (e.g., crashed before cleanup)
        const stillExists = await readServerLock(root);
        if (stillExists) {
          await clearServerLock(root);
          try {
            await unregisterServer(root);
          } catch {
            // Ignore registry errors - server may have already cleaned up
          }
        }
      } catch (err) {
        console.error("Failed to stop server:", err);
      }
    }
  });

/** Subcommand: Show osgrep server status for current directory. */
const statusCommand = new Command("status")
  .description("Show osgrep server status")
  .action(async () => {
    const root = process.cwd();
    const lock = await readServerLock(root);

    if (!lock) {
      console.log("No osgrep server is running in this directory.");
      return;
    }

    const running = isProcessRunning(lock.pid);

    if (running) {
      console.log("osgrep server status:");
      console.log(`  Directory: ${root}`);
      console.log(`  Port:      ${lock.port}`);
      console.log(`  PID:       ${lock.pid}`);
      console.log(`  Status:    running`);
    } else {
      console.log("osgrep server status:");
      console.log(`  Directory: ${root}`);
      console.log(`  Port:      ${lock.port}`);
      console.log(`  PID:       ${lock.pid}`);
      console.log(`  Status:    not running (stale lock file)`);
      console.log("\nRun 'osgrep serve stop' to clean up the stale lock file.");
    }
  });

// Add subcommands to serve
serve.addCommand(stopCommand);
serve.addCommand(statusCommand);
