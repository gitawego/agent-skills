// Inbox items: the only place a person is asked for something.
import fs from "node:fs";
import path from "node:path";
import { campaignInboxDir, ensureDir, exists, nowIso, readJson, writeJson } from "./util.mjs";

export function itemId(kind, ticket) {
  const ts = nowIso().replace(/[-:]/g, "").replace("Z", "");
  return `${kind[0]}-${ts}-${ticket || "campaign"}`;
}

export function createItem(root, slug, item) {
  const id = item.id || itemId(item.kind || "question", item.ticket);
  const record = {
    id,
    campaign: slug,
    ticket: item.ticket || null,
    run: item.run || null,
    kind: item.kind || "question",
    title: item.title || "",
    brief: item.brief || "",
    question: item.question || null,
    findings: item.findings || null,
    status: "open",
    created: nowIso(),
    answer: null,
  };
  const file = path.join(campaignInboxDir(root, slug), `${id}.json`);
  ensureDir(path.dirname(file));
  writeJson(file, record);
  return record;
}

export function listItems(root, slug, { status } = {}) {
  const dir = campaignInboxDir(root, slug);
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(dir, f)))
    .filter(Boolean)
    .filter((item) => !status || item.status === status)
    .sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

export function findItem(root, slug, id) {
  return readJson(path.join(campaignInboxDir(root, slug), `${id}.json`), null);
}

export function updateItem(root, slug, id, patch) {
  const file = path.join(campaignInboxDir(root, slug), `${id}.json`);
  const current = readJson(file, null);
  if (!current) return null;
  const next = { ...current, ...patch };
  writeJson(file, next);
  return next;
}

export function openItemForTicket(root, slug, ticketId, kind) {
  return listItems(root, slug, { status: "open" }).find(
    (item) => item.ticket === ticketId && (!kind || item.kind === kind),
  );
}
