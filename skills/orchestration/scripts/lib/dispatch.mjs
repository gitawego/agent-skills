// The console-wide dispatch switch. One file, one reason, never touches live runs.
import path from "node:path";
import { consoleStateDir, nowIso, readJson, writeJson } from "./util.mjs";

export const DISPATCH_MODES = ["auto", "paused"];

export function dispatchFile() {
  return path.join(consoleStateDir(), "dispatch.json");
}

export function loadDispatch() {
  const raw = readJson(dispatchFile(), null);
  return {
    version: 1,
    mode: raw?.mode === "paused" ? "paused" : "auto",
    reason: raw?.reason || null,
    at: raw?.at || null,
    by: raw?.by || null,
  };
}

export function setDispatch(mode, { reason = null, by = "panel" } = {}) {
  if (!DISPATCH_MODES.includes(mode)) throw new Error(`dispatch mode must be one of ${DISPATCH_MODES.join(", ")}`);
  const text = String(reason || "").trim();
  if (mode === "paused" && !text) throw new Error("pausing dispatch requires a reason");
  const record = {
    version: 1,
    mode,
    reason: text || null,
    at: nowIso(),
    by,
  };
  writeJson(dispatchFile(), record);
  return record;
}

export function dispatchPaused() {
  return loadDispatch().mode === "paused";
}
