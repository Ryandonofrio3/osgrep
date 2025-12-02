import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("Server Registry", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "osgrep-registry-test-"));
  });

  afterEach(async () => {
    vi.doUnmock("node:os");
    vi.resetModules();
    try {
      await fs.rm(tempHome, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("registerServer adds entry to registry", async () => {
    vi.doMock("node:os", () => {
      const realOs = require("node:os") as typeof import("node:os");
      return { ...realOs, homedir: () => tempHome };
    });

    const { registerServer, listAllServers } = await import("../src/utils");

    await registerServer({
      cwd: "/test/project1",
      port: 4444,
      pid: 1234,
      authToken: "token1",
    });

    const servers = await listAllServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toEqual({
      cwd: "/test/project1",
      port: 4444,
      pid: 1234,
      authToken: "token1",
    });
  });

  it("registerServer replaces existing entry for same cwd", async () => {
    vi.doMock("node:os", () => {
      const realOs = require("node:os") as typeof import("node:os");
      return { ...realOs, homedir: () => tempHome };
    });

    const { registerServer, listAllServers } = await import("../src/utils");

    await registerServer({
      cwd: "/test/project1",
      port: 4444,
      pid: 1234,
    });

    await registerServer({
      cwd: "/test/project1",
      port: 5555,
      pid: 5678,
    });

    const servers = await listAllServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].port).toBe(5555);
    expect(servers[0].pid).toBe(5678);
  });

  it("unregisterServer removes entry from registry", async () => {
    vi.doMock("node:os", () => {
      const realOs = require("node:os") as typeof import("node:os");
      return { ...realOs, homedir: () => tempHome };
    });

    const { registerServer, unregisterServer, listAllServers } = await import("../src/utils");

    await registerServer({
      cwd: "/test/project1",
      port: 4444,
      pid: 1234,
    });

    await registerServer({
      cwd: "/test/project2",
      port: 5555,
      pid: 5678,
    });

    await unregisterServer("/test/project1");

    const servers = await listAllServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].cwd).toBe("/test/project2");
  });

  it("listAllServers returns all registered servers", async () => {
    vi.doMock("node:os", () => {
      const realOs = require("node:os") as typeof import("node:os");
      return { ...realOs, homedir: () => tempHome };
    });

    const { registerServer, listAllServers } = await import("../src/utils");

    await registerServer({ cwd: "/project1", port: 4444, pid: 1111 });
    await registerServer({ cwd: "/project2", port: 4445, pid: 2222 });
    await registerServer({ cwd: "/project3", port: 4446, pid: 3333 });

    const servers = await listAllServers();
    expect(servers).toHaveLength(3);
    expect(servers.map((s) => s.cwd).sort()).toEqual([
      "/project1",
      "/project2",
      "/project3",
    ]);
  });

  it("clearAllServers empties the registry", async () => {
    vi.doMock("node:os", () => {
      const realOs = require("node:os") as typeof import("node:os");
      return { ...realOs, homedir: () => tempHome };
    });

    const { registerServer, clearAllServers, listAllServers } = await import("../src/utils");

    await registerServer({ cwd: "/project1", port: 4444, pid: 1111 });
    await registerServer({ cwd: "/project2", port: 4445, pid: 2222 });

    await clearAllServers();

    const servers = await listAllServers();
    expect(servers).toHaveLength(0);
  });

  it("listAllServers returns empty array when registry does not exist", async () => {
    vi.doMock("node:os", () => {
      const realOs = require("node:os") as typeof import("node:os");
      return { ...realOs, homedir: () => tempHome };
    });

    const { listAllServers } = await import("../src/utils");

    const servers = await listAllServers();
    expect(servers).toHaveLength(0);
  });
});

describe("isProcessRunning", () => {
  it("returns true for current process", async () => {
    const { isProcessRunning } = await import("../src/utils");

    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it("returns false for non-existent process", async () => {
    const { isProcessRunning } = await import("../src/utils");

    // Use a very high PID that's unlikely to exist
    expect(isProcessRunning(999999999)).toBe(false);
  });
});

describe("Server Lock", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "osgrep-lock-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("writeServerLock creates lock file and readServerLock reads it", async () => {
    const { writeServerLock, readServerLock } = await import("../src/utils");

    await writeServerLock(4444, 1234, tempDir, "test-token");

    const lock = await readServerLock(tempDir);
    expect(lock).not.toBeNull();
    expect(lock?.port).toBe(4444);
    expect(lock?.pid).toBe(1234);
    expect(lock?.authToken).toBe("test-token");
  });

  it("clearServerLock removes the lock file", async () => {
    const { writeServerLock, readServerLock, clearServerLock } = await import("../src/utils");

    await writeServerLock(4444, 1234, tempDir, "test-token");

    let lock = await readServerLock(tempDir);
    expect(lock).not.toBeNull();

    await clearServerLock(tempDir);

    lock = await readServerLock(tempDir);
    expect(lock).toBeNull();
  });

  it("readServerLock returns null when no lock file exists", async () => {
    const { readServerLock } = await import("../src/utils");

    const lock = await readServerLock(tempDir);
    expect(lock).toBeNull();
  });

  it("clearServerLock handles non-existent lock file gracefully", async () => {
    const { clearServerLock } = await import("../src/utils");

    // Should not throw
    await expect(clearServerLock(tempDir)).resolves.toBeUndefined();
  });
});

