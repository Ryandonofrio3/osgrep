const fs = require("node:fs");
const _path = require("node:path");
const { spawn } = require("node:child_process");

function readPayload() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function isProcessRunning(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findProjectRoot(startDir) {
  const start = _path.resolve(startDir || process.cwd());
  const osgrepDir = _path.join(start, ".osgrep");
  const gitDir = _path.join(start, ".git");
  if (fs.existsSync(osgrepDir) || fs.existsSync(gitDir)) return start;
  return start;
}

function getServerForProject(projectRoot) {
  try {
    const regPath = _path.join(require("node:os").homedir(), ".osgrep", "servers.json");
    if (!fs.existsSync(regPath)) return null;
    const data = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    if (!Array.isArray(data)) return null;
    return data.find((s) => s && s.projectRoot === projectRoot && isProcessRunning(s.pid)) || null;
  } catch {
    return null;
  }
}

function main() {
  const payload = readPayload();
  const cwd = payload.cwd || process.cwd();
  if (process.env.OSGREP_DISABLE_AUTO_SERVE === "1") {
    const response = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "osgrep serve auto-start disabled (OSGREP_DISABLE_AUTO_SERVE=1).",
      },
    };
    process.stdout.write(JSON.stringify(response));
    return;
  }

  const projectRoot = findProjectRoot(cwd);
  const existing = getServerForProject(projectRoot);
  const logPath = "/tmp/osgrep.log";
  const out = fs.openSync(logPath, "a");

  if (!existing) {
    const child = spawn("osgrep", ["serve", "--background"], {
      cwd,
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
  }

  const response = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        existing
          ? `osgrep serve running (PID: ${existing.pid}, Port: ${existing.port}).`
          : 'osgrep serve starting (indexing in background). Searches work immediately but may show partial results until indexing completes.',
    },
  };
  process.stdout.write(JSON.stringify(response));
}

main();
