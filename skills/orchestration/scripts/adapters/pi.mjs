// pi adapter: the original CLI worker, now behind the adapter interface.
import { spawnSync } from "node:child_process";
import { listPiModels, resetPiCatalog } from "../lib/pi-catalog.mjs";
import { buildWorkerArgv } from "../lib/runs.mjs";

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

export function buildLaunch({ run, modelEntry, thinking, tools, prompt, sessionsDir, systemPrompts, command }) {
  return {
    command: command || process.env.PI_BIN || "pi",
    argv: buildWorkerArgv({ run, modelEntry, thinking, tools, prompt, sessionsDir, systemPrompts }),
    env: {},
  };
}
