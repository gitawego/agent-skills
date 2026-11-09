// The append-only event ledger. One line per transition, never rewritten.
import fs from "node:fs";
import { appendJsonl, campaignEventsFile, ensureDir, nowIso, readJsonl } from "./util.mjs";

export function appendEvent(root, event) {
  const record = { ts: nowIso(), ...event };
  ensureDir(campaignEventsFile(root).replace(/\/[^/]+$/, ""));
  appendJsonl(campaignEventsFile(root), record);
  return record;
}

export function readEvents(root) {
  return readJsonl(campaignEventsFile(root));
}

export function readEventsFrom(root, index = 0) {
  return readEvents(root).slice(Math.max(0, index));
}

export function countEvents(root) {
  try {
    return fs.readFileSync(campaignEventsFile(root), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
