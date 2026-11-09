// The colony's memory: decisions written by the supervisor, read by every worker,
// superseded when a later decision covers the same ground.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  campaignDecisionsFile,
  consoleStateDir,
  ensureDir,
  exists,
  nowIso,
  readJsonl,
} from "./util.mjs";
import { touchesOverlap } from "./plan.mjs";

const CONSOLE_FILE = "decisions.jsonl";

export function consoleDecisionsFile() {
  return path.join(consoleStateDir(), CONSOLE_FILE);
}

export function normalizeQuestion(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[`*_>#]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function questionHash(text) {
  const normalized = normalizeQuestion(text);
  if (!normalized) return null;
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

export function decisionId(seed) {
  return `d-${createHash("sha1").update(String(seed)).digest("hex").slice(0, 8)}`;
}

function readScope(file) {
  return readJsonl(file);
}

function rewrite(file, records) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
}

export function readDecisions(root, slug, { includeSuperseded = false } = {}) {
  const local = readScope(campaignDecisionsFile(root, slug)).map((record) => ({ ...record, scope: "campaign" }));
  const shared = readScope(consoleDecisionsFile()).map((record) => ({ ...record, scope: "console" }));
  const all = [...shared, ...local];
  return includeSuperseded ? all : all.filter((record) => !record.supersededBy);
}

/* Two decisions conflict when they answer the same question, or when they are the
   same claim about the same set of paths. Mere overlap is too coarse: a decision
   about src/** must not silently retire one about src/api/x.ts. */
function supersedes(candidate, existing) {
  if (candidate.questionHash && candidate.questionHash === existing.questionHash) return true;
  const a = [...(candidate.paths || [])].sort().join("|");
  const b = [...(existing.paths || [])].sort().join("|");
  return Boolean(a) && a === b;
}

export function appendDecision(root, slug, record) {
  const file = campaignDecisionsFile(root, slug);
  const existing = readScope(file);
  const hash = record.questionHash ?? questionHash(record.question);
  const decision = {
    id: decisionId(`${record.text}|${nowIso()}`),
    ts: nowIso(),
    campaign: slug,
    ticket: record.ticket || null,
    text: String(record.text || "").trim(),
    cite: record.cite || null,
    by: record.by || "human",
    paths: record.paths || [],
    question: record.question || null,
    questionHash: hash || null,
    supersededBy: null,
    promoted: false,
  };
  for (const prior of existing) {
    if (!prior.supersededBy && supersedes(decision, prior)) prior.supersededBy = decision.id;
  }
  rewrite(file, [...existing, decision]);
  return decision;
}

const STOP = new Set(["the", "a", "an", "is", "are", "to", "of", "for", "and", "or", "in", "on", "it", "this", "that", "which", "should", "we", "i", "do", "be"]);

function tokens(text) {
  return new Set(normalizeQuestion(text).split(" ").filter((word) => word.length >= 3 && !STOP.has(word)));
}

/* Same question in different words. Containment rather than Jaccard, because a
   re-ask usually adds a clause rather than rewording the whole sentence; a match
   still needs three shared significant words. */
function similarQuestion(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size < 3 || right.size < 3) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / Math.min(left.size, right.size) >= 0.8;
}

export function findAnswer(root, slug, question) {
  const hash = questionHash(question);
  if (!hash) return null;
  const decisions = readDecisions(root, slug);
  const exact = decisions.find((record) => record.questionHash === hash && record.text);
  if (exact) return exact;
  return decisions.find((record) => record.text && record.question && similarQuestion(record.question, question)) || null;
}

/* What a worker needs: the decisions that can bear on its paths, plus the general
   ones that name no path at all. */
export function decisionsFor(root, slug, touches = []) {
  const active = readDecisions(root, slug);
  return active.filter((record) => {
    if (!record.paths || !record.paths.length) return true;
    return touches.length ? touchesOverlap(record.paths, touches) : true;
  });
}

export function promoteDecision(root, slug, id) {
  const file = campaignDecisionsFile(root, slug);
  const local = readScope(file);
  const target = local.find((record) => record.id === id);
  if (!target) return null;
  target.promoted = true;
  rewrite(file, local);
  const sharedFile = consoleDecisionsFile();
  const shared = readScope(sharedFile);
  shared.push({ ...target, scope: "console", campaign: slug, promotedFrom: slug });
  rewrite(sharedFile, shared);
  return target;
}

/* A decision about code that no longer exists is a stale trail. At delivery,
   retire the ones whose paths have all vanished; a path is gone when even its
   literal prefix is missing. */
export function retireMissingPaths(root, slug) {
  const file = campaignDecisionsFile(root, slug);
  const records = readScope(file);
  const retired = [];
  for (const record of records) {
    if (record.supersededBy || !record.paths || !record.paths.length) continue;
    const alive = record.paths.some((glob) => {
      const literal = String(glob).split("*")[0].replace(/\/$/, "");
      return literal === "" || exists(path.join(root, literal));
    });
    if (!alive) {
      record.supersededBy = "paths-removed";
      retired.push(record);
    }
  }
  if (retired.length) rewrite(file, records);
  return retired;
}

export function summaryLine(record) {
  return `${record.text}${record.cite ? ` (${record.cite})` : ""}`;
}
