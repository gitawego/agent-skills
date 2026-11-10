// pi adapter: the original CLI worker, now behind the adapter interface.
import { spawnSync } from "node:child_process";
import { ensureDir } from "../lib/util.mjs";
import { listPiModels, resetPiCatalog } from "../lib/pi-catalog.mjs";
import { buildWorkerArgv } from "../lib/runs.mjs";
import { wrapCommand } from "../lib/sandbox.mjs";

export const id = "pi";
export const label = "pi";

export function reset() {
  resetPiCatalog();
}

let versionCache = null;

export function version() {
  if (versionCache) return versionCache;
  const res = spawnSync(process.env.PI_BIN || "pi", ["--version"], { encoding: "utf8", timeout: 15_000 });
  versionCache = res.status === 0 ? (res.stdout || "").trim().split("\n")[0] : null;
  return versionCache;
}

export function capabilities() {
  return {
    systemPrompt: "append-file",
    tools: "allowlist",
    thinking: "flag",
    resume: "session-id",
    usage: "json-events",
    streaming: true,
    billing: "metered",
  };
}

export function listModels({ refresh = false } = {}) {
  return listPiModels({ refresh });
}

export function buildLaunch({ run, modelEntry, thinking, tools, prompt, sessionsDir, systemPrompts, attachments = [], runDir, workdir, sandbox, command }) {
  if (sessionsDir) ensureDir(sessionsDir);
  const base = buildWorkerArgv({ run, modelEntry, thinking, tools, prompt, sessionsDir, systemPrompts, attachments });
  const wrapped = wrapCommand({
    command: command || process.env.PI_BIN || "pi",
    args: base,
    cwd: workdir,
    rwPaths: [sessionsDir, runDir],
    mode: sandbox || "auto",
  });
  return { command: wrapped.command, argv: wrapped.args, env: {} };
}
