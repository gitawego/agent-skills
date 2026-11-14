// Per-campaign machine state: stages, live runs, slots, spend.
import path from "node:path";
import fs from "node:fs";
import { campaignStateFile, exists, nowIso, pidAlive, readJson, writeJson } from "./util.mjs";
import { appendEvent, readEvents } from "./ledger.mjs";
import { asArray } from "./plan.mjs";

export const STAGES = [
  "blocked",
  "queued",
  "working",
  "needs_answer",
  "needs_changes",
  "failed",
  "done",
  "dropped",
];

export function emptyState(slug) {
  return {
    campaign: slug,
    stage: "draft",
    reason: null,
    tickets: {},
    runs: {},
    slots: {},
    spend: { tokens: 0, dollars: 0, byModel: {} },
    approvedAt: null,
    deliveredAt: null,
    planErrors: [],
    integration: null,
    deliveryAudit: null,
  };
}

export function loadState(root, slug) {
  const file = campaignStateFile(root, slug);
  const raw = readJson(file, null);
  if (!raw) return rebuild(root, slug);
  return { ...emptyState(slug), ...raw, spend: { ...emptyState(slug).spend, ...(raw.spend || {}) } };
}

function rebuild(root, slug) {
  const state = emptyState(slug);
  for (const event of readEvents(root)) {
    if (event.campaign !== slug) continue;
    if (event.type === "campaign.approved") {
      state.stage = "running";
      state.approvedAt = event.ts;
    }
    if (event.type === "campaign.paused") {
      state.stage = "paused";
      state.reason = event.data?.reason || null;
    }
    if (event.type === "campaign.resumed") state.stage = "running";
    if (event.type === "campaign.delivered") {
      state.stage = "delivered";
      state.deliveredAt = event.ts;
    }
    if (event.type === "ticket.stage" && event.ticket) {
      state.tickets[event.ticket] = {
        ...(state.tickets[event.ticket] || {}),
        stage: event.data?.to,
        updated: event.ts,
      };
    }
    if (event.type === "gate.integration") {
      state.integration = {
        head: event.data?.head || null,
        status: event.data?.result === "pass" ? "passed" : "failed",
        at: event.ts,
        checks: event.data?.checks || [],
      };
    }
    if (event.type === "delivery.blocked") {
      state.deliveryAudit = {
        ok: false,
        blockers: event.data?.blockers || [],
        warnings: event.data?.warnings || [],
        at: event.ts,
      };
    }
  }
  recoverFromRuns(root, slug, state);
  return state;
}

/* A lost state file must not forget attempts, gates or spend: the run records
   under .orchestration are the authority for all three. */
function recoverFromRuns(root, slug, state) {
  const dir = path.join(path.dirname(campaignStateFile(root, slug)), "runs");
  if (!exists(dir)) return;
  for (const id of fs.readdirSync(dir)) {
    const record = readJson(path.join(dir, id, "run.json"), null);
    if (!record) continue;
    if (record.status === "live" && !pidAlive(record.pid)) record.status = "done";
    state.runs[id] = record;
    const usage = record.usage || null;
    if (usage) {
      state.spend.tokens += usage.tokens || 0;
      state.spend.dollars += usage.dollars || 0;
      if (record.model) {
        const entry = state.spend.byModel[record.model] || { tokens: 0, dollars: 0, unmetered: 0 };
        entry.tokens += usage.tokens || 0;
        entry.dollars += usage.dollars || 0;
        if (usage.unmetered) entry.unmetered += 1;
        state.spend.byModel[record.model] = entry;
      }
    }
    if (!record.ticket || record.role !== "work") {
      if (record.ticket && record.role === "review") {
        const ticket = (state.tickets[record.ticket] = state.tickets[record.ticket] || { stage: "queued" });
        ticket.gateCycles = (ticket.gateCycles || 0) + 1;
        ticket.reviewModel = record.model || ticket.reviewModel;
        ticket.workerModel = record.workerModel || ticket.workerModel;
        ticket.reviewedHead = record.reviewedHead || ticket.reviewedHead;
        ticket.reviewedBase = record.reviewedBase || ticket.reviewedBase;
        if (record.report?.findings) ticket.findings = record.report.findings;
      }
      continue;
    }
    const ticket = (state.tickets[record.ticket] = state.tickets[record.ticket] || { stage: "queued" });
    ticket.attempts = (ticket.attempts || 0) + 1;
    ticket.run = id;
    ticket.model = record.model || ticket.model;
    ticket.workerModel = record.model || ticket.workerModel;
    ticket.workdir = record.workdir || ticket.workdir;
    ticket.sessionId = record.sessionId || ticket.sessionId;
    if (record.report?.acceptance) ticket.acceptance = record.report.acceptance;
    if (Array.isArray(record.report?.checks)) ticket.checks = record.report.checks;
    if (record.report?.next) ticket.next = record.report.next;
  }
}

export function saveState(root, slug, state) {
  writeJson(campaignStateFile(root, slug), state);
  return state;
}

export function ensureTickets(state, plan) {
  for (const ticket of plan.ordered) {
    const id = ticket.data.id;
    if (!state.tickets[id]) {
      const blockers = asArray(ticket.data.blocked_by).map((b) => String(b).padStart(2, "0"));
      state.tickets[id] = {
        stage: blockers.length ? "blocked" : "queued",
        attempts: 0,
        gateCycles: 0,
        run: null,
        updated: nowIso(),
      };
    }
  }
  for (const id of Object.keys(state.tickets)) {
    if (!plan.byId.has(id)) delete state.tickets[id];
  }
  return state;
}

export function ticketState(state, id) {
  if (!state.tickets[id]) state.tickets[id] = { stage: "queued", attempts: 0, gateCycles: 0, run: null };
  return state.tickets[id];
}

export function setStage(root, slug, state, ticketId, stage, extra = {}) {
  const entry = ticketState(state, ticketId);
  const from = entry.stage;
  if (from === stage && !extra.force) return entry;
  entry.stage = stage;
  entry.updated = nowIso();
  Object.assign(entry, extra.patch || {});
  appendEvent(root, {
    campaign: slug,
    ticket: ticketId,
    run: extra.run || entry.run || undefined,
    type: "ticket.stage",
    data: { from, to: stage, reason: extra.reason || undefined },
  });
  return entry;
}

export function liveRuns(state) {
  return Object.entries(state.runs).filter(([, run]) => run.status === "live");
}

export function campaignStage(root, slug, state, stage, reason = null) {
  if (state.stage === stage) {
    state.reason = reason;
    return;
  }
  const from = state.stage;
  state.stage = stage;
  state.reason = reason;
  const type = {
    draft: "campaign.created",
    awaiting_approval: "plan.drafted",
    running: "campaign.resumed",
    paused: "campaign.paused",
    delivered: "campaign.delivered",
    archived: "campaign.archived",
  }[stage];
  appendEvent(root, { campaign: slug, type, data: { from, to: stage, reason: reason || undefined } });
}

export function addSpend(state, { model, tokens, dollars, unmetered }) {
  state.spend.tokens += tokens || 0;
  state.spend.dollars += dollars || 0;
  if (unmetered) state.spend.unmetered = (state.spend.unmetered || 0) + 1;
  if (model) {
    const entry = state.spend.byModel[model] || { tokens: 0, dollars: 0, unmetered: 0 };
    entry.tokens += tokens || 0;
    entry.dollars += dollars || 0;
    if (unmetered) entry.unmetered += 1;
    state.spend.byModel[model] = entry;
  }
}

export function budgetExhausted(state, budget) {
  if (!budget) return null;
  if (budget.tokens != null && state.spend.tokens >= budget.tokens) return "tokens";
  if (budget.dollars != null && state.spend.dollars >= budget.dollars) return "dollars";
  return null;
}

export function runDir(root, slug, runId) {
  return path.join(path.dirname(campaignStateFile(root, slug)), "runs", runId);
}

export function saveRunRecord(root, slug, runId, record) {
  const dir = runDir(root, slug, runId);
  const file = path.join(dir, "run.json");
  const current = readJson(file, {});
  writeJson(file, { ...current, ...record });
  return file;
}

export function readRunRecord(root, slug, runId) {
  return readJson(path.join(runDir(root, slug, runId), "run.json"), null);
}

export function listRunRecords(root, slug) {
  const dir = path.join(path.dirname(campaignStateFile(root, slug)), "runs");
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((id) => ({ id, ...readRunRecord(root, slug, id) }))
    .sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
}
