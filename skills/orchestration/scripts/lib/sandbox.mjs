// Optional OS-level sandbox for worker processes. Linux/bwrap only; other
// platforms keep the path-based permission guard and run unsandboxed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let available;

export function bwrapAvailable() {
  if (available != null) return available;
  if (process.platform !== "linux") return (available = false);
  const res = spawnSync("bwrap", ["--version"], { encoding: "utf8", timeout: 5000 });
  available = res.status === 0;
  return available;
}

export function sandboxMode(value) {
  if (value === "none") return "none";
  if (value === "bwrap") return bwrapAvailable() ? "bwrap" : "none";
  return bwrapAvailable() ? "bwrap" : "none";
}

/* Wrap a command so / is read-only and only the worktree, run directory,
   temp and harness state dirs are writable. Network stays shared: the worker
   must reach its model API. */
export function wrapCommand({ command, args, cwd, rwPaths = [], mode = "auto" }) {
  if (sandboxMode(mode) !== "bwrap") return { command, args };
  const roots = [
    cwd,
    os.tmpdir(),
    path.join(os.homedir(), ".pi"),
    path.join(os.homedir(), ".gemini"),
    path.join(os.homedir(), ".config", "opencode"),
    path.join(os.homedir(), ".local", "share", "opencode"),
    path.join(os.homedir(), ".local", "state", "opencode"),
    path.join(os.homedir(), ".cache", "opencode"),
    process.env.XDG_RUNTIME_DIR,
    ...rwPaths,
  ].filter(Boolean);
  if (cwd) {
    try {
      const res = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir", "--git-dir"], { encoding: "utf8", timeout: 2000 });
      if (res.status === 0) {
        for (const line of res.stdout.trim().split("\n")) {
          if (line.trim()) roots.push(path.resolve(cwd, line.trim()));
        }
      }
    } catch {
      // ignore
    }
  }
  const bargs = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--chdir", cwd];
  const seen = new Set();
  for (const root of roots) {
    const abs = path.resolve(root);
    if (seen.has(abs) || !fs.existsSync(abs)) continue;
    seen.add(abs);
    bargs.push("--bind", abs, abs);
  }
  bargs.push("--", command, ...args);
  return { command: "bwrap", args: bargs };
}
