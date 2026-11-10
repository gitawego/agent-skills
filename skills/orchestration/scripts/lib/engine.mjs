// The engine: one tick reconciles stages, collects runs, gates, dispatches, delivers.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  UserError,
  campaignDecisionsFile,
  campaignSessionsDir,
  campaignStateFile,
  exists,
  ensureDir,
  git,
  nowIso,
  readJson,
  readJsonl,
  readText,
} from "./util.mjs";
import {
  addSpend,
  budgetExhausted,
  campaignStage,
  ensureTickets,
  liveRuns,
  loadState,
  runDir,
  saveRunRecord,
  saveState,
  setStage,
  ticketState,
} from "./state.mjs";
import { appendEvent } from "./ledger.mjs";
import { asArray, loadPlan, matchTouches, ticketTitle, touchesOverlap } from "./plan.mjs";
import {
  campaignFile,
  entryAdapter,
  listCampaigns,
  loadConsole,
  modelKey,
  readCampaign,
  resolveKinds,
  resolveModel,
  resetCatalog,
  runnerConfig,
  saveConsole,
  validateCampaign,
} from "./config.mjs";
import { adapterIds, getAdapter, readCatalogCache, refreshCatalog, rowsFor } from "./catalogs.mjs";
import { ADAPTER_IDS, SPEND_MODES } from "./adapter-ids.mjs";
import { joinFrontmatter, splitFrontmatter, updateFrontmatter } from "./yaml.mjs";
import {
  childrenFromLog,
  killRun,
  newRunId,
  rollupChildren,
  runStuck,
  runTimedOut,
  sessionIdFor,
  startRun,
  summarizeRun,
  writePrompt,
} from "./runs.mjs";
import { judgePrompt, mergePrompt, promptDigest, resumePrompt, reviewPrompt, systemPromptDigest, systemPromptFiles, workerPrompt } from "./prompts.mjs";
import { createItem, findItem, listItems, openItemForTicket, updateItem } from "./inbox.mjs";
import { attachmentAudit, attachmentPaths, loadAttachments } from "./attachments.mjs";
import {
  changedSince,
  deliverBranch,
  diffStats,
  ensureIntegration,
  ensureTicketWorktree,
  integrationBranch,
  mergeTicket,
  pruneWorktrees,
  snapshotDir,
  writeManifest,
} from "./landing.mjs";
import { drainCommands } from "./commands.mjs";
import { addTicket, createCampaign, editTicket, removeTicket } from "./create.mjs";
import { loadDispatch, setDispatch } from "./dispatch.mjs";
import { quotaBlock, quotaText, resolveQuotas, validateQuotas } from "./quotas.mjs";
import {
  appendDecision,
  decisionsFor,
  findAnswer,
  promoteDecision,
  readDecisions,
  retireMissingPaths,
  summaryLine,
} from "./memory.mjs";

const DONE = new Set(["done", "dropped"]);

function blockersOf(ticket) {
  return asArray(ticket.data.blocked_by).map((b) => String(b).padStart(2, "0"));
}

function syncBlockedQueued(root, slug, state, plan) {
  for (const ticket of plan.ordered) {
    const id = ticket.data.id;
    const entry = ticketState(state, id);
    const satisfied = blockersOf(ticket).every((b) => DONE.has(state.tickets[b]?.stage));
    if (entry.stage === "queued" && !satisfied) setStage(root, slug, state, id, "blocked");
    else if (entry.stage === "blocked" && satisfied) setStage(root, slug, state, id, "queued");
  }
}

export function writeStageToPlan(root, slug, stage) {
  const file = campaignFile(root, slug);
  const text = readText(file, null);
  if (!text) return;
  const next = updateFrontmatter(text, { stage });
  if (next !== text) fs.writeFileSync(file, next);
}

export function tick({ root }) {
  const consoleConfig = loadConsole();
  const drained = drainCommands(root, (command) => applyCommand(root, command, consoleConfig));
  const results = [];
  for (const slug of listCampaigns(root)) {
    try {
      results.push(tickCampaign(root, slug, consoleConfig));
    } catch (err) {
      appendEvent(root, { campaign: slug, type: "error", data: { message: err.message } });
      results.push({ slug, error: err.message });
    }
  }
  return { drained, results };
}

export function tickCampaign(root, slug, consoleConfig) {
  const campaign = readCampaign(root, slug);
  const data = campaign.data;
  const plan = loadPlan(root, slug);
  const firstLoad = !exists(campaignStateFile(root, slug));
  const state = loadState(root, slug);
  if (firstLoad && data.stage) state.stage = data.stage;
  ensureTickets(state, plan);

  const catalog = catalogRowsFor(root, data, consoleConfig);
  const validation = validateCampaign({ root, consoleConfig, data, tickets: plan.ordered, catalogRows: catalog.map });
  state.planErrors = [...plan.errors, ...validation.errors];
  const kinds = validation.kinds || resolveKinds(consoleConfig, data);

  if (state.stage === "draft" && plan.ordered.length) {
    campaignStage(root, slug, state, "awaiting_approval");
  }
  if (state.stage === "awaiting_approval" && data.plan_gate === "auto" && !state.planErrors.length) {
    approveCampaign(root, slug, consoleConfig, { automatic: true, state });
  }

  syncBlockedQueued(root, slug, state, plan);
  collectRuns(root, slug, state, plan, kinds, consoleConfig, data);

  const dispatch = loadDispatch();
  if (state.stage === "running") {
    const exhausted = budgetExhausted(state, data.budget);
    if (exhausted) {
      campaignStage(root, slug, state, "paused", `budget exhausted (${exhausted})`);
      if (!openItemForTicket(root, slug, null, "failure")) {
        createItem(root, slug, {
          kind: "failure",
          title: `Campaign paused: ${exhausted} budget spent`,
          brief: `Spend reached ${state.spend.tokens} tokens and $${state.spend.dollars.toFixed(2)}.`,
        });
      }
    } else if (dispatch.mode !== "paused") {
      dispatchFrontier(root, slug, state, plan, kinds, consoleConfig, data);
    }
  }
  annotateQueue(root, slug, state, plan, kinds, consoleConfig, data, dispatch);

  const delivered = maybeDeliver(root, slug, state, plan, data);
  if (delivered) writeClose(root, slug, state, plan, data);
  saveState(root, slug, state);
  if (state.stage !== "draft") writeStageToPlan(root, slug, state.stage);
  return { slug, stage: state.stage, tickets: summarizeTickets(state, plan) };
}

export function summarizeTickets(state, plan) {
  return plan.ordered.map((ticket) => {
    const entry = state.tickets[ticket.data.id] || { stage: "queued" };
    const run = entry.run ? state.runs[entry.run] : null;
    return {
      id: ticket.data.id,
      title: ticketTitle(ticket),
      kind: ticket.data.kind,
      stage: entry.stage,
      attempts: entry.attempts || 0,
      gateCycles: entry.gateCycles || 0,
      waitingOn: entry.waitingOn || null,
      run: run ? { id: run.id, role: run.role, model: run.model, status: run.status } : null,
    };
  });
}

// --- collection ------------------------------------------------------------

function releaseSlot(state, run) {
  for (const [ticketId, runId] of Object.entries(state.slots)) {
    if (runId === run.id) delete state.slots[ticketId];
  }
  run.status = "done";
  run.endedAt = nowIso();
}

function collectRuns(root, slug, state, plan, kinds, consoleConfig, data) {
  for (const [runId, run] of Object.entries(state.runs)) {
    if (run.status !== "live") continue;
    const kind = kinds[run.kind];
    const alive = run.pid ? processAlive(run.pid) : false;
    if (alive) {
      const timeoutMin = kind?.timeout_min || consoleConfig.limits.run_timeout_min;
      if (runTimedOut(run, timeoutMin)) {
        killRun(run);
        run.killed = "timeout";
      } else if (runStuck(run, consoleConfig.limits.stuck_after_min)) {
        killRun(run);
        run.killed = "stuck";
      } else {
        continue;
      }
    }
    const summary = summarizeRun(root, slug, runId);
    const session = readJson(path.join(runDir(root, slug, runId), "session.json"), null);
    if (session?.sessionId) run.sessionId = session.sessionId;
    if (session?.config) run.appliedConfig = session.config;
    run.usage = summary.usage;
    addSpend(state, { model: run.model, ...summary.usage });
    const children = childrenFromLog(root, slug, runId);
    const childUsage = rollupChildren(children);
    if (children.length) {
      run.children = children;
      run.childUsage = childUsage;
      if (childUsage.tokens || childUsage.dollars) {
        addSpend(state, {
          model: run.model,
          tokens: childUsage.tokens,
          dollars: childUsage.dollars,
          unmetered: Boolean(summary.usage?.unmetered),
        });
      }
    }
    appendEvent(root, {
      campaign: slug,
      ticket: run.ticket,
      run: run.id,
      type: "run.reported",
      data: {
        status: summary.report?.status || "missing",
        killed: run.killed || undefined,
        tokens: summary.usage.tokens,
        cost: summary.usage.dollars,
      },
    });
    run.reportStatus = summary.report?.status || null;
    run.report = summary.report || null;
    run.logTail = summary.logTail;
    run.errors = summary.errors;
    releaseSlot(state, run);
    saveRunRecord(root, slug, runId, { ...run });

    const ctx = { root, slug, state, plan, kinds, consoleConfig, run, summary, data };
    if (run.role === "work") collectWork(ctx);
    else if (run.role === "review") collectReview(ctx);
    else if (run.role === "judge") collectJudge(ctx);
    else if (run.role === "merge") collectMerge(ctx);
  }
}

function processAlive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const state = stat.slice(close + 2).split(" ")[0];
    if (state === "Z" || state === "X") return false;
    return true;
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === "EPERM";
    }
  }
}

function firstLine(text) {
  return String(text || "").split("\n")[0].slice(0, 140);
}

function adapterAudit(adapter) {
  const caps = adapter.capabilities ? adapter.capabilities() : {};
  return {
    adapterVersion: adapter.version ? adapter.version() : null,
    systemPromptMode: caps.systemPrompt || null,
    toolsMode: caps.tools || null,
  };
}

/* Billing and context travel with the run, so a later catalog change cannot
   rewrite the meaning of an old report. */
function modelAudit(modelEntry) {
  return {
    price: modelEntry?.price || null,
    billing: modelEntry?.billing || null,
    included: modelEntry?.included === true,
    plan: modelEntry?.plan || null,
    contextTokens: modelEntry?.contextTokens || null,
    maxOutTokens: modelEntry?.maxOutTokens || null,
  };
}

function catalogRowsFor(root, data, consoleConfig) {
  const runner = runnerConfig(consoleConfig, data);
  const kinds = resolveKinds(consoleConfig, data);
  const ids = new Set([runner.adapter]);
  for (const kind of Object.values(kinds)) {
    for (const entry of kind.models || []) ids.add(entry.adapter || runner.adapter);
  }
  const map = {};
  for (const id of ids) {
    try {
      map[id] = rowsFor(id, root);
    } catch {
      map[id] = [];
    }
  }
  return { runner, kinds, map };
}

function nextChainIndex(run) {
  const length = run.chain?.length || 0;
  const index = (run.chainIndex || 0) + 1;
  return index < length ? index : null;
}

function failedRun({ root, slug, state, plan, run, summary, consoleConfig, kinds, data }) {
  const ticketId = run.ticket;
  const entry = ticketState(state, ticketId);
  const attempts = entry.attempts || 0;
  const reason = summary.errors?.length
    ? summary.errors.join("; ")
    : `run ended as ${summary.report?.status || "no report"}`;
  const canRetry = attempts < consoleConfig.limits.max_attempts;
  const nextIndex = nextChainIndex(run);

  if (canRetry && run.killed !== "stopped") {
    if (nextIndex != null) entry.chainIndex = nextIndex;
    setStage(root, slug, state, ticketId, "queued", { reason });
    appendEvent(root, {
      campaign: slug,
      ticket: ticketId,
      run: run.id,
      type: "run.retried",
      data: { reason, nextModel: nextIndex != null ? run.chain[nextIndex] : undefined },
    });
    return;
  }

  setStage(root, slug, state, ticketId, "failed", { reason });
  if (!openItemForTicket(root, slug, ticketId, "failure")) {
    createItem(root, slug, {
      kind: "failure",
      ticket: ticketId,
      run: run.id,
      title: `${ticketId} failed: ${firstLine(reason)}`,
      brief: summary.report?.summary || reason,
      findings: String(summary.logTail || "").split("\n").slice(-60).join("\n"),
    });
  }
}

function collectWork({ root, slug, state, plan, kinds, consoleConfig, run, summary, data }) {
  const ticketId = run.ticket;
  const ticket = plan.byId.get(ticketId);
  const entry = ticketState(state, ticketId);

  if (run.killed === "timeout" || summary.errors?.length || !summary.report) {
    return failedRun({ root, slug, state, plan, run, summary, consoleConfig, kinds, data });
  }

  const report = summary.report;
  entry.actualTouches = [...new Set([...(entry.actualTouches || []), ...(report.touched || [])])];
  entry.summary = report.summary;
  entry.sessionId = run.sessionId;
  entry.model = run.model;
  entry.workdir = run.workdir;

  switch (report.status) {
    case "ready": {
      const checks = runChecks(root, slug, run.workdir, data.checks || []);
      const failed = checks.filter((c) => !c.ok);
      if (failed.length) {
        const findings = failed.map((c) => `check "${c.name}" failed:\n${c.output}`).join("\n\n");
        return sendBack({ root, slug, state, run, findings });
      }
      const drift =
        (data.landing || "branch") === "directory"
          ? dirDrift({ root, ticket, data, before: entry.before })
          : diffDrift({ root, slug, run, ticket, data });
      if (drift) return sendBack({ root, slug, state, run, findings: drift });
      return startReview({ root, slug, state, plan, ticket, run, kinds, consoleConfig });
    }
    case "needs_answer": {
      const question = report.question;
      if (!question || !String(question.text || "").trim()) {
        return failedRun({ root, slug, state, plan, run, summary, consoleConfig, kinds, data });
      }
      const known = findAnswer(root, slug, question.text);
      if (known) {
        appendEvent(root, {
          campaign: slug,
          ticket: ticketId,
          run: run.id,
          type: "question.answered",
          data: { answer: known.text, citation: known.cite, by: "decision", decision: known.id },
        });
        entry.answer = { text: known.text, citation: known.cite, by: "decision" };
        entry.pendingResume = { answer: known.text, citation: known.cite, from: "orchestrator" };
        setStage(root, slug, state, ticketId, "queued", { reason: "already decided" });
        return;
      }
      return startJudge({
        root,
        slug,
        state,
        plan,
        ticket,
        run,
        report,
        kinds,
        consoleConfig,
      });
    }
    case "dropped":
      setStage(root, slug, state, ticketId, "dropped", { reason: report.summary });
      return;
    case "progress":
      setStage(root, slug, state, ticketId, "queued", { reason: "checkpointed" });
      return;
    default:
      return failedRun({ root, slug, state, plan, run, summary, consoleConfig, kinds, data });
  }
}

function collectReview({ root, slug, state, plan, kinds, consoleConfig, run, summary, data }) {
  const ticketId = run.ticket;
  const entry = ticketState(state, ticketId);
  if (summary.errors?.length || !summary.report) {
    setStage(root, slug, state, ticketId, "failed", { reason: "the review run produced no report" });
    if (!openItemForTicket(root, slug, ticketId, "failure")) {
      createItem(root, slug, {
        kind: "failure",
        ticket: ticketId,
        run: run.id,
        title: `${ticketId}: the reviewer broke`,
        brief: summary.errors.join("; "),
        findings: summary.logTail,
      });
    }
    return;
  }
  const report = summary.report;
  if (report.status === "ready") {
    const land = landTicket({ root, slug, ticketId, data });
    if (land.ok) {
      setStage(root, slug, state, ticketId, "done", { reason: "gates passed" });
      appendEvent(root, {
        campaign: slug,
        ticket: ticketId,
        run: run.id,
        type: "gate.review",
        data: { result: "pass", detail: report.summary },
      });
      return;
    }
    if (land.conflict) {
      return startMerge({ root, slug, state, ticketId, run, conflict: land.output, kinds, consoleConfig });
    }
    setStage(root, slug, state, ticketId, "failed", { reason: land.output });
    if (!openItemForTicket(root, slug, ticketId, "failure")) {
      createItem(root, slug, {
        kind: "failure",
        ticket: ticketId,
        run: run.id,
        title: `${ticketId}: could not land`,
        brief: land.output,
      });
    }
    return;
  }
  return sendBack({ root, slug, state, run, findings: report.summary });
}

function sendBack({ root, slug, state, run, findings }) {
  const ticketId = run.ticket;
  const entry = ticketState(state, ticketId);
  entry.gateCycles = (entry.gateCycles || 0) + 1;
  entry.findings = findings;
  setStage(root, slug, state, ticketId, "needs_changes", { reason: "gates failed" });
  appendEvent(root, {
    campaign: slug,
    ticket: ticketId,
    run: run.id,
    type: "gate.check",
    data: { result: "fail", findings: firstLine(findings) },
  });
  if (entry.gateCycles >= 3) {
    setStage(root, slug, state, ticketId, "failed", { reason: "three gate cycles" });
    if (!openItemForTicket(root, slug, ticketId, "failure")) {
      createItem(root, slug, {
        kind: "failure",
        ticket: ticketId,
        run: run.id,
        title: `${ticketId}: three gate cycles`,
        brief: "The ticket failed its gates three times. That is a spec problem, not an execution one.",
        findings,
      });
    }
  }
}

function collectJudge({ root, slug, state, plan, run, summary }) {
  const ticketId = run.ticket;
  const entry = ticketState(state, ticketId);
  const report = summary.report;
  const cited = report && report.status === "ready" && /^cite:/i.test(String(report.next || ""));
  if (cited) {
    appendEvent(root, {
      campaign: slug,
      ticket: ticketId,
      run: run.id,
      type: "question.answered",
      data: { answer: report.summary, citation: report.next, by: "orchestrator" },
    });
    entry.answer = { text: report.summary, citation: report.next, by: "orchestrator" };
    const ticket = plan.byId.get(ticketId);
    appendDecision(root, slug, {
      text: report.summary,
      cite: report.next,
      by: "orchestrator",
      ticket: ticketId,
      paths: asArray(ticket?.data.touches),
      question: run.question?.text,
    });
    setStage(root, slug, state, ticketId, "queued", { reason: "answered from a written source" });
    entry.pendingResume = { answer: report.summary, citation: report.next, from: "orchestrator" };
    return;
  }
  const question = run.question || { text: "(no question text captured)" };
  if (!openItemForTicket(root, slug, ticketId, "question")) {
    createItem(root, slug, {
      kind: "question",
      ticket: ticketId,
      run: run.id,
      title: `${ticketId}: ${firstLine(question.text)}`,
      brief: entry.summary || "",
      question,
    });
  }
  setStage(root, slug, state, ticketId, "needs_answer", { reason: "waiting for a person" });
}

function collectMerge({ root, slug, state, run, summary }) {
  const ticketId = run.ticket;
  if (summary.report?.status === "ready") {
    setStage(root, slug, state, ticketId, "done", { reason: "merged" });
    appendEvent(root, { campaign: slug, ticket: ticketId, run: run.id, type: "merge.done", data: {} });
    return;
  }
  setStage(root, slug, state, ticketId, "needs_answer", { reason: "unresolved conflict" });
  if (!openItemForTicket(root, slug, ticketId, "question")) {
    createItem(root, slug, {
      kind: "question",
      ticket: ticketId,
      run: run.id,
      title: `${ticketId}: merge conflict needs a decision`,
      brief: summary.report?.summary || "A merge could not be resolved automatically.",
      findings: run.conflict || "",
      question: {
        text: `The integration branch conflicts with ${ticketId}. How should the two changes be combined?`,
        options: [],
      },
    });
  }
}

// --- gates -----------------------------------------------------------------

function runChecks(root, slug, workdir, checks) {
  const results = [];
  for (const check of checks) {
    const started = Date.now();
    const res = spawnSync("/bin/sh", ["-c", check.cmd], {
      cwd: workdir,
      encoding: "utf8",
      timeout: 15 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const captured = String(`${res.stdout || ""}${res.stderr || ""}`).trim();
    const output = (captured || `(no output, exit ${res.status})`).split("\n").slice(-40).join("\n");
    results.push({ name: check.name, ok: res.status === 0, output, ms: Date.now() - started });
    appendEvent(root, { campaign: slug, type: "gate.check", data: { name: check.name, ok: res.status === 0 } });
  }
  return results;
}

/* A report is a marker. Check it against the work: the branch must exist, and it
   must not wander outside the paths the ticket declared. */
function diffDrift({ root, slug, run, ticket, data }) {
  if ((data.landing || "branch") !== "branch") return null;
  const base = integrationBranch(slug);
  const diff = git(run.workdir, ["diff", "--name-only", `${base}...HEAD`]);
  if (!diff.ok) return null;
  const files = diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!files.length) {
    return "The branch has no changes against the integration branch. Commit the work, or report `dropped` if there was none.";
  }
  const allowed = [...asArray(ticket?.data.touches), ...asArray(data.allow_paths)];
  const escapes = files.filter((file) => !matchTouches(allowed, file));
  if (!escapes.length) return null;
  return [
    `The diff leaves the paths this ticket declared (${asArray(ticket?.data.touches).join(", ")}):`,
    ...escapes.map((file) => `  ${file}`),
    "",
    "Either narrow the change back into the declared paths, or say in your report that the ticket's `touches` were wrong and stop.",
  ].join("\n");
}

/* The same check for a campaign with no branches: what changed on disk since the
   run started, and does every one of those files belong to the ticket? */
function dirDrift({ root, ticket, data, before }) {
  if (!before) return null;
  const changed = changedSince(root, before);
  if (!changed.length) {
    return "No files changed since the run started. Write the deliverable, or report `dropped` if there was nothing to do.";
  }
  const allowed = [...asArray(ticket?.data.touches), ...asArray(data.allow_paths)];
  const escapes = changed.filter((file) => !matchTouches(allowed, file));
  if (!escapes.length) return null;
  return [
    `These files changed outside the paths this ticket declared (${allowed.join(", ")}):`,
    ...escapes.map((file) => `  ${file}`),
    "",
    "Revert what does not belong to this ticket, or say in your report that its `touches` were wrong and stop.",
  ].join("\n");
}

function landTicket({ root, slug, ticketId, data }) {
  if ((data.landing || "branch") === "directory") return { ok: true };
  return mergeTicket(root, slug, ticketId);
}

// --- starting runs ---------------------------------------------------------

function dispatchTicket({ root, slug, state, plan, ticket, kinds, consoleConfig, data, resume = null }) {
  const id = ticket.data.id;
  const entry = ticketState(state, id);
  const kind = kinds[ticket.data.kind];
  const runner = runnerConfig(consoleConfig, data);
  const entryInfo = (index) => {
    const item = kind.models[index];
    const adapterId = item?.adapter || runner.adapter;
    let rows = [];
    try {
      rows = rowsFor(adapterId, root);
    } catch {
      rows = [];
    }
    return { item, adapterId, rows, model: item ? resolveModel(item.model, rows) : null };
  };
  let chainIndex = entry.chainIndex || 0;
  const quotas = resolveQuotas(consoleConfig, data);
  const quotaOf = (info) =>
    info.model ? quotaBlock(quotas, { provider: info.model.provider, adapter: info.adapterId }) : null;
  let chosen = entryInfo(chainIndex);
  if (!chosen.model || quotaOf(chosen)) {
    const start = chainIndex;
    const order = kind.models.map((_, index) => (start + index) % kind.models.length);
    const candidates = order.map((index) => entryInfo(index));
    const viable = candidates.find((info) => info.model && !quotaOf(info));
    if (!viable) {
      const withModel = candidates.find((info) => info.model);
      if (!withModel) {
        setStage(root, slug, state, id, "failed", { reason: `no usable model for kind "${ticket.data.kind}"` });
        return null;
      }
      const blocked = quotaOf(withModel);
      entry.queue = {
        code: "quota",
        text: `quota blocked: ${quotaText(blocked)}`,
        at: nowIso(),
      };
      return null;
    }
    chainIndex = kind.models.indexOf(viable.item);
    chosen = viable;
  }
  let adapterId = chosen.adapterId;
  let modelEntry = chosen.model;
  let thinking = chosen.item.thinking || "medium";

  const landing = data.landing || "branch";
  let workdir = root;
  if (landing === "directory" && !entry.before) entry.before = snapshotDir(root);
  const before = entry.before || null;
  if (landing === "branch") {
    const integration = ensureIntegration(root, slug, data.base || "main");
    const wt = ensureTicketWorktree(root, slug, id, integration.branch);
    workdir = wt.dir;
    const merge = git(workdir, ["merge", "--no-ff", "--no-edit", integrationBranch(slug)]);
    if (!merge.ok) {
      git(workdir, ["merge", "--abort"]);
      entry.mergeRetries = (entry.mergeRetries || 0) + 1;
      if (entry.mergeRetries >= 2) {
        setStage(root, slug, state, id, "needs_answer", { reason: "the integration branch will not merge in" });
        if (!openItemForTicket(root, slug, id, "question")) {
          createItem(root, slug, {
            kind: "question",
            ticket: id,
            title: `${id}: the integration branch conflicts with this ticket`,
            brief: merge.stderr || merge.stdout,
            question: { text: `How should ${id} be combined with the integration branch?`, options: [] },
          });
        }
      }
      return null;
    }
    entry.mergeRetries = 0;
  }

  const attempt = (entry.attempts || 0) + 1;
  const runId = newRunId(id, "work", attempt);
  const sessionId =
    adapterId === "pi"
      ? resume
        ? sessionIdFor(slug, id, "work")
        : sessionIdFor(slug, id, attempt > 1 ? `work-a${attempt}` : "work")
      : resume
        ? entry.sessionId || null
        : null;
  const attached = loadAttachments(root, attachmentPaths(ticket));
  if (attached.errors.length) {
    setStage(root, slug, state, id, "failed", { reason: attached.errors.join("; ") });
    if (!openItemForTicket(root, slug, id, "failure")) {
      createItem(root, slug, {
        kind: "failure",
        ticket: id,
        title: `${id}: attachment rejected`,
        brief: attached.errors.join("\n"),
      });
    }
    return null;
  }
  if (attached.items.some((item) => item.kind === "image") && modelEntry.images !== true) {
    const alt = kind.models.findIndex((_, index) => {
      const info = entryInfo(index);
      return info.model?.images === true && !quotaOf(info);
    });
    if (alt < 0) {
      const reason = `kind "${ticket.data.kind}" has image attachments, but its models cannot read images`;
      setStage(root, slug, state, id, "failed", { reason });
      if (!openItemForTicket(root, slug, id, "failure")) {
        createItem(root, slug, {
          kind: "failure",
          ticket: id,
          title: `${id}: no vision model bound`,
          brief: reason,
        });
      }
      return null;
    }
    chainIndex = alt;
    chosen = entryInfo(alt);
    adapterId = chosen.adapterId;
    modelEntry = chosen.model;
    thinking = chosen.item.thinking || "medium";
  }
  const campaign = readCampaign(root, slug);
  const prompt = resume
    ? resumePrompt({
        ticket: id,
        answer: resume.answer,
        citation: resume.citation,
        findings: resume.findings,
        attachments: attached.items.map((item) => item.path),
      })
    : workerPrompt({
        campaign: slug,
        ticket: id,
        ticketTitle: ticketTitle(ticket),
        runId,
        workdir,
        base: data.base || "main",
        kind: ticket.data.kind,
        decisions: decisionsFor(root, slug, asArray(ticket.data.touches)),
        sections: campaign.sections,
        data: ticket,
        attachments: attached.items.map((item) => item.path),
      });
  writePrompt(root, slug, runId, prompt);

  const systemPrompts = systemPromptFiles(ticket.data.kind);
  const run = {
    id: runId,
    campaign: slug,
    ticket: id,
    role: "work",
    kind: ticket.data.kind,
    adapter: adapterId,
    ...adapterAudit(getAdapter(adapterId)),
    ...modelAudit(modelEntry),
    sandbox: runner.sandbox,
    catalogFetchedAt: readCatalogCache(adapterId)?.fetchedAt || null,
    model: modelKey(modelEntry),
    chain: kind.models.map((m) => m.model),
    chainIndex,
    sessionId,
    touches: asArray(ticket.data.touches),
    question: resume?.question || null,
    before,
    attachments: attachmentAudit(attached.items),
    systemPrompts,
    systemPromptHash: systemPromptDigest(systemPrompts),
    promptHash: promptDigest(prompt),
  };
  const launch = getAdapter(adapterId).buildLaunch({
    run,
    modelEntry,
    thinking,
    tools: kind.tools,
    prompt,
    attachments: attached.items,
    sessionsDir: campaignSessionsDir(root, slug),
    systemPrompts,
    runDir: runDir(root, slug, runId),
    workdir,
    sandbox: runner.sandbox,
    command: consoleConfig.runner?.command || "pi",
  });
  const record = startRun({
    root,
    slug,
    run,
    argv: launch.argv,
    command: launch.command,
    env: launch.env || {},
    workdir,
  });
  state.runs[runId] = record;
  state.slots[id] = runId;
  entry.attempts = attempt;
  entry.run = runId;
  entry.chainIndex = chainIndex;
  delete entry.pendingResume;
  setStage(root, slug, state, id, "working", { run: runId, reason: resume ? "resumed" : "dispatched" });
  appendEvent(root, {
    campaign: slug,
    ticket: id,
    run: runId,
    type: "run.dispatched",
    data: { model: run.model, workdir, role: "work", resumed: Boolean(resume) },
  });
  return record;
}

function startReview({ root, slug, state, plan, ticket, run, kinds, consoleConfig }) {
  const id = ticket.data.id;
  const entry = ticketState(state, id);
  const campaign = readCampaign(root, slug);
  const runner = runnerConfig(consoleConfig, campaign.data);
  const kind = kinds.review || kinds[ticket.data.kind];
  const reviewInfo = (index) => {
    const item = kind.models[index];
    const adapterId = item?.adapter || runner.adapter;
    let rows = [];
    try {
      rows = rowsFor(adapterId, root);
    } catch {
      rows = [];
    }
    return { item, adapterId, rows, model: item ? resolveModel(item.model, rows) : null };
  };
  let index = 0;
  let current = reviewInfo(index);
  let modelEntry = current.model;
  if (!modelEntry) {
    index = kind.models.findIndex((_, i) => reviewInfo(i).model);
    if (index < 0) {
      return failedRun({
        root,
        slug,
        state,
        plan,
        run,
        summary: { errors: ["the review kind has no usable model"], logTail: "", report: null },
        consoleConfig,
        kinds,
      });
    }
    current = reviewInfo(index);
    modelEntry = current.model;
  }
  const runId = newRunId(id, "review", (entry.gateCycles || 0) + 1);
  const sessionId = current.adapterId === "pi" ? sessionIdFor(slug, id, `review${(entry.gateCycles || 0) + 1}`) : null;
  const attached = loadAttachments(root, attachmentPaths(ticket));
  if (attached.errors.length) {
    return failedRun({
      root,
      slug,
      state,
      plan,
      run,
      summary: { errors: attached.errors, logTail: "", report: null },
      consoleConfig,
      kinds,
    });
  }
  if (attached.items.some((item) => item.kind === "image") && modelEntry.images !== true) {
    const alt = kind.models.findIndex((_, i) => reviewInfo(i).model?.images === true);
    if (alt < 0) {
      return failedRun({
        root,
        slug,
        state,
        plan,
        run,
        summary: { errors: ["the ticket has image attachments, but the review chain has no vision model"], logTail: "", report: null },
        consoleConfig,
        kinds,
      });
    }
    index = alt;
    current = reviewInfo(alt);
    modelEntry = current.model;
  }
  const prompt = reviewPrompt({
    campaign: slug,
    ticket: id,
    ticketTitle: ticketTitle(ticket),
    runId,
    workdir: run.workdir,
    base: (campaign.data.landing || "branch") === "branch" ? integrationBranch(slug) : (campaign.data.base || "main"),
    kind: ticket.data.kind,
    data: ticket,
    landing: campaign.data.landing || "branch",
    attachments: attached.items.map((item) => item.path),
  });
  writePrompt(root, slug, runId, prompt);
  const systemPrompts = systemPromptFiles("review");
  const gateRun = {
    id: runId,
    campaign: slug,
    ticket: id,
    role: "review",
    kind: "review",
    adapter: current.adapterId,
    ...adapterAudit(getAdapter(current.adapterId)),
    ...modelAudit(modelEntry),
    model: modelKey(modelEntry),
    chain: kind.models.map((m) => m.model),
    chainIndex: index,
    sessionId,
    touches: [],
    attachments: attachmentAudit(attached.items),
    sandbox: runner.sandbox,
    systemPrompts,
    systemPromptHash: systemPromptDigest(systemPrompts),
    promptHash: promptDigest(prompt),
  };
  const launch = getAdapter(current.adapterId).buildLaunch({
    run: gateRun,
    modelEntry,
    thinking: current.item.thinking || "high",
    tools: kind.tools,
    prompt,
    attachments: attached.items,
    sessionsDir: campaignSessionsDir(root, slug),
    systemPrompts,
    runDir: runDir(root, slug, runId),
    workdir: run.workdir,
    sandbox: runner.sandbox,
    command: campaign.data.runner?.command || consoleConfig.runner?.command || "pi",
  });
  const record = startRun({
    root,
    slug,
    run: gateRun,
    argv: launch.argv,
    command: launch.command,
    env: launch.env || {},
    workdir: run.workdir,
  });
  state.runs[runId] = record;
  entry.gateRun = runId;
  entry.run = runId;
  state.slots[id] = runId;
  setStage(root, slug, state, id, "working", { run: runId, reason: "reviewing" });
  appendEvent(root, {
    campaign: slug,
    ticket: id,
    run: runId,
    type: "run.dispatched",
    data: { role: "review", model: gateRun.model },
  });
  return record;
}

function startJudge({ root, slug, state, plan, ticket, run, report, kinds, consoleConfig }) {
  const id = ticket.data.id;
  const entry = ticketState(state, id);
  const campaign = readCampaign(root, slug);
  const runner = runnerConfig(consoleConfig, campaign.data);
  const kind = kinds.plan;
  const item = kind.models[0];
  const adapterId = item?.adapter || runner.adapter;
  let rows = [];
  try {
    rows = rowsFor(adapterId, root);
  } catch {
    rows = [];
  }
  const modelEntry = resolveModel(item?.model || "", rows);
  if (!modelEntry) {
    if (!openItemForTicket(root, slug, id, "question")) {
      createItem(root, slug, {
        kind: "question",
        ticket: id,
        run: run.id,
        title: `${id}: ${firstLine(report.question?.text)}`,
        brief: report.summary,
        question: report.question,
      });
    }
    setStage(root, slug, state, id, "needs_answer");
    return null;
  }
  const runId = newRunId(id, "judge", 1);
  const sessionId = adapterId === "pi" ? sessionIdFor(slug, id, `judge${runId.slice(-6)}`) : null;
  const prompt = judgePrompt({
    campaign: slug,
    ticket: id,
    ticketTitle: ticketTitle(ticket),
    question: report.question,
    summary: report.summary,
    sections: campaign.sections,
    data: ticket,
    decisions: readDecisions(root, slug),
  });
  writePrompt(root, slug, runId, prompt);
  const systemPrompts = systemPromptFiles("judge");
  const judgeRun = {
    id: runId,
    campaign: slug,
    ticket: id,
    role: "judge",
    kind: "plan",
    adapter: adapterId,
    ...adapterAudit(getAdapter(adapterId)),
    ...modelAudit(modelEntry),
    model: modelKey(modelEntry),
    chain: kind.models.map((m) => m.model),
    chainIndex: 0,
    sessionId,
    touches: [],
    question: report.question,
    sandbox: runner.sandbox,
    systemPrompts,
    systemPromptHash: systemPromptDigest(systemPrompts),
    promptHash: promptDigest(prompt),
  };
  const launch = getAdapter(adapterId).buildLaunch({
    run: judgeRun,
    modelEntry,
    thinking: kind.models[0]?.thinking || "high",
    tools: kind.tools,
    prompt,
    sessionsDir: campaignSessionsDir(root, slug),
    systemPrompts,
    runDir: runDir(root, slug, runId),
    workdir: root,
    sandbox: runner.sandbox,
    command: consoleConfig.runner?.command || "pi",
  });
  const record = startRun({
    root,
    slug,
    run: judgeRun,
    argv: launch.argv,
    command: launch.command,
    env: launch.env || {},
    workdir: root,
  });
  state.runs[runId] = record;
  entry.gateRun = runId;
  entry.run = runId;
  state.slots[id] = runId;
  setStage(root, slug, state, id, "working", { run: runId, reason: "judging the question" });
  appendEvent(root, { campaign: slug, ticket: id, run: runId, type: "run.dispatched", data: { role: "judge" } });
  return record;
}

function startMerge({ root, slug, state, ticketId, run, conflict, kinds, consoleConfig }) {
  const campaign = readCampaign(root, slug);
  const runner = runnerConfig(consoleConfig, campaign.data);
  const kind = kinds.chores || kinds.code;
  const item = kind.models[0];
  const adapterId = item?.adapter || runner.adapter;
  let rows = [];
  try {
    rows = rowsFor(adapterId, root);
  } catch {
    rows = [];
  }
  const modelEntry = resolveModel(item?.model || "", rows);
  if (!modelEntry) {
    setStage(root, slug, state, ticketId, "needs_answer", { reason: "conflict, and no model to merge with" });
    if (!openItemForTicket(root, slug, ticketId, "question")) {
      createItem(root, slug, {
        kind: "question",
        ticket: ticketId,
        run: run.id,
        title: `${ticketId}: merge conflict`,
        brief: conflict,
        question: { text: `The integration branch conflicts with ${ticketId}. How should they be combined?`, options: [] },
      });
    }
    return null;
  }
  const { dir } = ensureIntegration(root, slug, campaign.data.base || "main");
  const runId = newRunId(ticketId, "merge", 1);
  const sessionId = adapterId === "pi" ? sessionIdFor(slug, ticketId, `merge${runId.slice(-6)}`) : null;
  const prompt = mergePrompt({ root: dir, slug, ticket: ticketId, conflict });
  writePrompt(root, slug, runId, prompt);
  const systemPrompts = systemPromptFiles("merge");
  const mergeRun = {
    id: runId,
    campaign: slug,
    ticket: ticketId,
    role: "merge",
    kind: "chores",
    adapter: adapterId,
    ...adapterAudit(getAdapter(adapterId)),
    ...modelAudit(modelEntry),
    model: modelKey(modelEntry),
    chain: kind.models.map((m) => m.model),
    chainIndex: 0,
    sessionId,
    touches: [],
    conflict,
    sandbox: runner.sandbox,
    systemPrompts,
    systemPromptHash: systemPromptDigest(systemPrompts),
    promptHash: promptDigest(prompt),
  };
  const launch = getAdapter(adapterId).buildLaunch({
    run: mergeRun,
    modelEntry,
    thinking: kind.models[0]?.thinking || "low",
    tools: "default",
    prompt,
    sessionsDir: campaignSessionsDir(root, slug),
    systemPrompts,
    runDir: runDir(root, slug, runId),
    workdir: dir,
    sandbox: runner.sandbox,
    command: consoleConfig.runner?.command || "pi",
  });
  const record = startRun({
    root,
    slug,
    run: mergeRun,
    argv: launch.argv,
    command: launch.command,
    env: launch.env || {},
    workdir: dir,
  });
  state.runs[runId] = record;
  const entry = ticketState(state, ticketId);
  entry.gateRun = runId;
  entry.run = runId;
  state.slots[ticketId] = runId;
  setStage(root, slug, state, ticketId, "working", { run: runId, reason: "resolving a merge" });
  appendEvent(root, {
    campaign: slug,
    ticket: ticketId,
    run: runId,
    type: "merge.conflict",
    data: { conflict: firstLine(conflict) },
  });
  return record;
}

// --- queue reasons ---------------------------------------------------------

/* A queued row must say why it is queued: slots, a lane, a quota, or a person.
   The panel renders this text verbatim, so it is written for a person. */
function annotateQueue(root, slug, state, plan, kinds, consoleConfig, data, dispatch) {
  const running = liveRuns(state).map(([, run]) => run);
  const total = running.length;
  const cap = consoleConfig.limits.max_concurrent;
  const perKind = {};
  for (const run of running) perKind[run.kind] = (perKind[run.kind] || 0) + 1;
  const touched = running.flatMap((run) => [
    ...asArray(run.touches),
    ...(state.tickets[run.ticket]?.actualTouches || []),
  ]);
  const quotas = resolveQuotas(consoleConfig, data);

  for (const ticket of plan.ordered) {
    const id = ticket.data.id;
    const entry = ticketState(state, id);
    if (!["queued", "blocked", "needs_changes"].includes(entry.stage)) {
      delete entry.queue;
      continue;
    }
    const kind = kinds[ticket.data.kind];
    const chain = kind?.models || [];
    const blockedBy = blockersOf(ticket).filter((blocker) => !DONE.has(state.tickets[blocker]?.stage));
    const chainStatus = chain.map((item) => {
      const adapterId = item.adapter || runnerConfig(consoleConfig, data).adapter;
      let rows = [];
      try {
        rows = rowsFor(adapterId, root);
      } catch {
        rows = [];
      }
      const model = resolveModel(item.model, rows);
      return {
        model,
        blocked: model ? quotaBlock(quotas, { provider: model.provider, adapter: adapterId }) : null,
      };
    });
    const quota =
      chainStatus.length && chainStatus.every((status) => !status.model || status.blocked)
        ? chainStatus.find((status) => status.blocked)?.blocked
        : null;

    let queue = null;
    if (entry.queue?.code === "quota" && quota) queue = entry.queue;
    else if (entry.stage === "blocked") {
      queue = { code: "blocked", text: `blocked by ${blockedBy.join(", ") || "an unfinished ticket"}` };
    } else if (state.stage !== "running") {
      queue = {
        code: "campaign",
        text: `campaign ${state.stage}${state.reason ? `: ${state.reason}` : ""}`,
      };
    } else if (dispatch.mode === "paused") {
      queue = { code: "dispatch", text: `dispatch paused${dispatch.reason ? `: ${dispatch.reason}` : ""}` };
    } else if (state.planErrors?.length) {
      queue = { code: "config", text: `plan has ${state.planErrors.length} error${state.planErrors.length === 1 ? "" : "s"}` };
    } else if (!chain.length) {
      queue = { code: "config", text: `no model bound for ${ticket.data.kind}` };
    } else if (quota) {
      queue = { code: "quota", text: `quota: ${quotaText(quota)}` };
    } else if (total >= cap) {
      queue = { code: "slots", text: `${total}/${cap} slots busy` };
    } else if (kind && (perKind[ticket.data.kind] || 0) >= kind.max_concurrent) {
      queue = {
        code: "slots",
        text: `${ticket.data.kind} ${perKind[ticket.data.kind] || 0}/${kind.max_concurrent} slots busy`,
      };
    } else if (entry.waitingOn) {
      queue = { code: "lane", text: `lane ${entry.waitingOn} is busy` };
    } else if (entry.stage === "needs_changes") {
      queue = { code: "ready", text: "gates sent it back, waiting for a slot" };
    } else if (entry.pendingResume) {
      queue = { code: "ready", text: "answer recorded, waiting for a slot" };
    } else {
      queue = { code: "ready", text: "ready for the next tick" };
    }
    entry.queue = { ...queue, at: nowIso() };
  }
}

// --- dispatch --------------------------------------------------------------

function dispatchFrontier(root, slug, state, plan, kinds, consoleConfig, data) {
  const running = liveRuns(state).map(([, run]) => run);
  let total = running.length;
  const perKind = {};
  for (const run of running) perKind[run.kind] = (perKind[run.kind] || 0) + 1;
  const touched = running.flatMap((run) => [
    ...asArray(run.touches),
    ...(state.tickets[run.ticket]?.actualTouches || []),
  ]);

  for (const ticket of plan.ordered) {
    const id = ticket.data.id;
    const entry = ticketState(state, id);
    const resumable = entry.stage === "queued" && entry.pendingResume;
    if (entry.stage !== "queued" && entry.stage !== "needs_changes") continue;
    const humanResume = entry.pendingResume?.from === "human";
    const cap = consoleConfig.limits.max_concurrent + (humanResume ? consoleConfig.limits.human_slot_extra : 0);
    if (total >= cap) continue;
    const kind = kinds[ticket.data.kind];
    if (!kind) continue;
    if ((perKind[ticket.data.kind] || 0) >= kind.max_concurrent) continue;

    const resume = resumable
      ? entry.pendingResume
      : entry.stage === "needs_changes"
        ? { findings: entry.findings }
        : null;

    const overlaps = asArray(ticket.data.touches).filter((glob) =>
      touched.some((other) => touchesOverlap([glob], [other])),
    );
    if (overlaps.length) {
      entry.waitingOn = overlaps[0];
      continue;
    }
    delete entry.waitingOn;

    const dispatched = dispatchTicket({ root, slug, state, plan, ticket, kinds, consoleConfig, data, resume });
    if (dispatched) {
      total++;
      perKind[ticket.data.kind] = (perKind[ticket.data.kind] || 0) + 1;
      touched.push(...asArray(ticket.data.touches));
    }
  }
}

// --- delivery --------------------------------------------------------------

function maybeDeliver(root, slug, state, plan, data) {
  if (state.stage !== "running") return false;
  if (!plan.ordered.length) return false;
  const allDone = plan.ordered.every((t) => DONE.has(state.tickets[t.data.id]?.stage));
  if (!allDone) return false;
  const landing = data.landing || "branch";
  if (landing === "directory") {
    const file = writeManifest(
      root,
      slug,
      plan.ordered.map((t) => ({ data: t.data, title: ticketTitle(t) })),
      root,
    );
    state.delivery = { mode: "directory", manifest: file, at: nowIso() };
    campaignStage(root, slug, state, "delivered");
    return true;
  }
  const base = data.base || "main";
  const stats = diffStats(root, slug, base);
  const maxLines = data.max_autoship_lines ?? 200;
  const allowMerge = (data.autonomy || "supervised") !== "supervised" && stats.lines <= maxLines;
  const res = deliverBranch(root, slug, { base, allowMerge });
  state.delivery = { ...res, stats, at: nowIso() };
  if (res.mode === "manual") {
    if (!openItemForTicket(root, slug, null, "review")) {
      createItem(root, slug, {
        kind: "review",
        title: `Campaign ready: ${slug}`,
        brief: `${stats.added} added, ${stats.removed} removed. ${res.detail}`,
      });
    }
  }
  campaignStage(root, slug, state, "delivered");
  return true;
}

/* The pheromone that survives the campaign: a short, non-destructive summary a
   person reads before the next one starts. The ledger stays the audit trail. */
function writeClose(root, slug, state, plan, data) {
  const rows = plan.ordered.map((ticket) => {
    const id = ticket.data.id;
    const entry = state.tickets[id] || {};
    const runs = Object.values(state.runs).filter((run) => run.ticket === id && run.role === "work");
    const cost = runs.reduce((sum, run) => sum + (run.usage?.dollars || 0), 0);
    const unmetered = runs.some((run) => run.usage?.unmetered);
    return {
      id,
      title: ticketTitle(ticket),
      kind: ticket.data.kind,
      stage: entry.stage,
      attempts: entry.attempts || 0,
      gateCycles: entry.gateCycles || 0,
      model: entry.model || runs[0]?.model || "—",
      cost,
      unmetered,
    };
  });
  const decisions = readDecisions(root, slug);
  const checks = (data.checks || []).map((check) => check.name).join(", ") || "none";
  const rough = rows.filter((row) => row.attempts > 1 || row.gateCycles > 0);
  const lines = [
    `# ${slug} — close`,
    "",
    `Closed ${new Date().toISOString().slice(0, 10)}. ${rows.filter((r) => r.stage === "done").length} of ${rows.length} tickets landed.`,
    "",
    "## Delivery",
    "",
    state.delivery?.mode === "merged"
      ? `Merged: ${state.delivery.detail || state.delivery.branch}`
      : state.delivery?.mode === "directory"
        ? `Artifacts in ${state.delivery.manifest}`
        : `Waited for a person: ${state.delivery?.detail || "branch left open"}`,
    "",
    "## Tickets",
    "",
    "| # | ticket | kind | result | tries | gates | model | cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.id} | ${row.title} | ${row.kind} | ${row.stage} | ${row.attempts} | ${row.gateCycles} | ${row.model} | ${row.unmetered ? "unmetered" : `$${row.cost.toFixed(4)}`} |`,
    ),
    "",
    `Checks: ${checks}. Spend: ${state.spend.tokens} tokens, $${state.spend.dollars.toFixed(4)}.`,
    "",
    "## Decisions",
    "",
    decisions.length ? decisions.map((record) => `- ${summaryLine(record)}`).join("\n") : "None recorded.",
    "",
    "## What was hard",
    "",
    rough.length
      ? rough
          .map(
            (row) =>
              `- ${row.id} ${row.title}: ${row.attempts} attempts, ${row.gateCycles} gate cycles. Ask what would have caught it earlier.`,
          )
          .join("\n")
      : "Nothing needed a second try.",
    "",
  ];
  const file = path.join(root, "orchestration", slug, "CLOSE.md");
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, lines.join("\n"));

  /* Only judge the paths once the work is on the base branch: a delivery that
     still waits for a person has not put the files there yet. */
  const landed = ["merged", "directory"].includes(state.delivery?.mode);
  const retired = landed ? retireMissingPaths(root, slug) : [];
  for (const record of retired) {
    appendEvent(root, { campaign: slug, type: "decision.retired", data: { id: record.id, text: record.text } });
  }
  const pruned = pruneWorktrees(root, slug);
  if (pruned.length) {
    appendEvent(root, { campaign: slug, type: "worktrees.pruned", data: { tickets: pruned } });
  }
}

// --- approval and commands -------------------------------------------------

export function approveCampaign(root, slug, consoleConfig, { automatic = false, state: given = null } = {}) {
  const campaign = readCampaign(root, slug);
  const plan = loadPlan(root, slug);
  const catalog = catalogRowsFor(root, campaign.data, consoleConfig);
  const map = {};
  try {
    for (const id of Object.keys(catalog.map)) {
      if (id !== "pi") refreshCatalog(id, { cwd: root });
      map[id] = rowsFor(id, root);
    }
  } catch (err) {
    throw new UserError(`Cannot approve "${slug}"`, [
      `an adapter could not discover models: ${err.message}`,
      err.hint || "Check that the harness is installed and signed in.",
    ]);
  }
  const { errors } = validateCampaign({
    root,
    consoleConfig,
    data: campaign.data,
    tickets: plan.ordered,
    catalogRows: map,
  });
  const all = [...plan.errors, ...errors];
  if (all.length) throw new UserError(`Cannot approve "${slug}"`, all);
  const state = given || loadState(root, slug);
  ensureTickets(state, plan);
  state.approvedAt = nowIso();
  campaignStage(root, slug, state, "running");
  saveState(root, slug, state);
  appendEvent(root, { campaign: slug, type: "campaign.approved", data: { automatic } });
  writeStageToPlan(root, slug, "running");
  return state;
}

export function applyCommand(root, command, consoleConfig) {
  const slug = command.campaign;
  const type = command.type;
  if (type === "dispatch.pause" || type === "dispatch.resume") {
    if (type === "dispatch.pause" && !String(command.reason || "").trim()) {
      throw new UserError("Pausing dispatch requires a reason", [
        "Say why: quota, budget, machine busy, or a person.",
      ]);
    }
    try {
      const dispatch = setDispatch(type === "dispatch.pause" ? "paused" : "auto", {
        reason: command.reason || null,
        by: command.by || "panel",
      });
      appendEvent(root, {
        type: type === "dispatch.pause" ? "dispatch.paused" : "dispatch.resumed",
        data: { reason: dispatch.reason || undefined, by: dispatch.by || undefined },
      });
      return { ok: true, dispatch };
    } catch (err) {
      throw new UserError(err.message);
    }
  }
  if (type === "catalog.refresh") {
    const config = loadConsole();
    const ids = command.adapter === "all" || command.all ? adapterIds() : [command.adapter || config.runner?.adapter || "pi"];
    const errors = [];
    for (const id of ids) {
      try {
        refreshCatalog(id, { cwd: root });
      } catch (err) {
        errors.push(`${id}: ${err.message}`);
      }
    }
    resetCatalog();
    return { ok: errors.length === 0, refreshed: true, adapters: ids, errors };
  }
  if (type === "settings.save") {
    const config = loadConsole();
    const patch = command.patch || {};
    if (patch.runner) {
      if (patch.runner.adapter && !ADAPTER_IDS.includes(patch.runner.adapter))
        throw new UserError(`unknown adapter "${patch.runner.adapter}"`);
      if (patch.runner.spend && !SPEND_MODES.includes(patch.runner.spend))
        throw new UserError(`unknown spend mode "${patch.runner.spend}"`);
      if (patch.runner.sandbox && !["auto", "bwrap", "none"].includes(patch.runner.sandbox))
        throw new UserError(`unknown sandbox mode "${patch.runner.sandbox}"`);
      config.runner = { ...config.runner, ...patch.runner };
    }
    if (patch.limits) {
      for (const [key, value] of Object.entries(patch.limits)) {
        if (!Number.isInteger(value) || value < 0) throw new UserError(`limits.${key} must be a positive integer`);
        config.limits[key] = value;
      }
    }
    if (patch.quotas) {
      const checked = validateQuotas(patch.quotas);
      if (checked.errors.length) throw new UserError(`Invalid quotas: ${checked.errors.join("; ")}`);
      config.quotas = checked.quotas;
    }
    for (const [id, change] of Object.entries(patch.kinds || {})) {
      const current = config.kinds[id];
      if (!current) throw new UserError(`unknown ticket kind "${id}"`);
      if (change.models) {
        for (const entry of change.models) {
          const adapterId = entry.adapter || config.runner?.adapter || "pi";
          const rows = rowsFor(adapterId, root);
          const resolved = resolveModel(entry.model, rows);
          if (!resolved) throw new UserError(`model "${entry.model}" is not in the ${adapterId} catalog`);
          if (config.runner?.spend === "subscription-only" && resolved.included === false)
            throw new UserError(`model "${entry.model}" is not included in the ${adapterId} subscription`);
        }
        current.models = change.models;
      }
      if (change.max_concurrent != null) {
        if (change.max_concurrent > config.limits.max_concurrent)
          throw new UserError(`kind "${id}" cap exceeds the console cap ${config.limits.max_concurrent}`);
        current.max_concurrent = change.max_concurrent;
      }
      if (change.timeout_min != null) current.timeout_min = change.timeout_min;
    }
    saveConsole(config);
    return { ok: true };
  }
  if (type === "approve") {
    approveCampaign(root, slug, consoleConfig);
    return { ok: true };
  }
  if (type === "deliver") {
    const state = loadState(root, slug);
    const base = readCampaign(root, slug).data.base || "main";
    const res = deliverBranch(root, slug, { base, allowMerge: true });
    state.delivery = { ...res, at: nowIso() };
    saveState(root, slug, state);
    appendEvent(root, { campaign: slug, type: "campaign.delivered", data: { mode: res.mode, detail: res.detail } });
    return { ok: res.mode === "merged", delivery: res };
  }
  if (type === "pause" || type === "resume") {
    const state = loadState(root, slug);
    const next = type === "pause" ? "paused" : "running";
    campaignStage(root, slug, state, next, command.reason || null);
    saveState(root, slug, state);
    writeStageToPlan(root, slug, next);
    if (next === "running") {
      /* A budget pause leaves a failure item; resuming after raising the
         ceiling should not leave it sitting in the inbox. */
      for (const item of listItems(root, slug, { status: "open" })) {
        if (item.kind === "failure" && /^Campaign paused: .*budget/.test(item.title || "")) {
          updateItem(root, slug, item.id, { status: "dismissed" });
        }
      }
    }
    return { ok: true };
  }
  if (type === "stop") {
    const state = loadState(root, slug);
    const id = String(command.ticket).padStart(2, "0");
    const rid = state.tickets[id]?.run;
    if (!rid || state.runs[rid]?.status !== "live") {
      throw new UserError(`Ticket ${id} has no live run`, ["Nothing to stop; the board shows what is running."]);
    }
    if (rid && state.runs[rid]) {
      killRun(state.runs[rid]);
      state.runs[rid].status = "done";
      state.runs[rid].endedAt = nowIso();
      state.runs[rid].killed = "stopped";
      delete state.slots[id];
    }
    setStage(root, slug, state, id, "queued", { reason: "stopped by a person" });
    saveState(root, slug, state);
    appendEvent(root, { campaign: slug, ticket: id, type: "run.stopped", data: {} });
    return { ok: true };
  }
  if (type === "retry" || type === "dispatch") {
    const state = loadState(root, slug);
    const id = String(command.ticket).padStart(2, "0");
    const entry = ticketState(state, id);
    if (DONE.has(entry.stage)) {
      throw new UserError(`Ticket ${id} is ${entry.stage} already`, [
        "A landed ticket is history. Add a new ticket for follow-up work.",
      ]);
    }
    entry.attempts = 0;
    entry.chainIndex = 0;
    entry.gateCycles = 0;
    delete entry.pendingResume;
    for (const item of listItems(root, slug, { status: "open" })) {
      if (item.ticket === id && item.kind === "failure") updateItem(root, slug, item.id, { status: "dismissed" });
    }
    setStage(root, slug, state, id, "queued", { reason: "retried by a person" });
    saveState(root, slug, state);
    return { ok: true };
  }
  if (type === "review.approve-bulk") {
    const ids = Array.isArray(command.items) ? command.items : [];
    if (!ids.length) throw new UserError("No review items selected");
    const items = ids.map((id) => findItem(root, slug, id));
    if (items.some((item) => !item || item.campaign !== slug || item.status !== "open" || item.kind !== "review"))
      throw new UserError("Bulk approval only applies to open delivery reviews in one campaign", [
        "Approve another campaign separately.",
      ]);
    const state = loadState(root, slug);
    const data = readCampaign(root, slug).data;
    const max = data.max_autoship_lines ?? 200;
    const lines = Number(state.delivery?.stats?.lines || 0);
    if (!state.delivery?.stats || lines > max) {
      throw new UserError(`Bulk approval is limited to one campaign under ${max} changed lines`, [
        `This delivery has ${state.delivery?.stats ? `${lines} changed lines` : "no recorded diff"}; approve it individually.`,
      ]);
    }
    for (const item of items) {
      applyCommand(root, { type: "review.approve", campaign: slug, item: item.id, text: command.text }, consoleConfig);
    }
    return { ok: true, approved: items.length };
  }
  if (type === "answer" || type === "review.approve" || type === "review.reject") {
    const item = findItem(root, slug, command.item);
    if (!item) throw new UserError(`No inbox item "${command.item}"`);
    if (item.status !== "open") throw new UserError(`Inbox item "${command.item}" is already ${item.status}`);
    const text = command.text || (type === "review.approve" ? "Approved." : "");
    const findings = type === "review.reject" ? command.text : null;
    const markAnswered = () => {
      updateItem(root, slug, item.id, {
        status: "answered",
        answer: { text: command.text || null, by: "human", at: nowIso() },
      });
      appendEvent(root, {
        campaign: slug,
        ticket: item.ticket,
        type: "inbox.answered",
        data: { item: item.id, kind: item.kind },
      });
    };

    if (!item.ticket) {
      if (type === "review.reject") {
        markAnswered();
        appendEvent(root, {
          campaign: slug,
          type: "delivery.rejected",
          data: { item: item.id, note: command.text || null },
        });
        return { ok: true, rejected: true };
      }
      const state = loadState(root, slug);
      const base = readCampaign(root, slug).data.base || "main";
      const stats = diffStats(root, slug, base);
      const res = deliverBranch(root, slug, { base, allowMerge: true });
      state.delivery = { ...res, stats, at: nowIso() };
      saveState(root, slug, state);
      /* An approval that did not merge is not an answer yet: keep the item
         open so the reason can be fixed and the same decision retried. */
      if (res.mode !== "merged") {
        appendEvent(root, {
          campaign: slug,
          type: "delivery.blocked",
          data: { item: item.id, detail: res.detail || null },
        });
        return { ok: false, delivery: res };
      }
      markAnswered();
      return { ok: true, delivery: res };
    }

    markAnswered();
    const state = loadState(root, slug);
    const plan = loadPlan(root, slug);
    const entry = ticketState(state, item.ticket);
    if (!findings) {
      appendDecision(root, slug, {
        text,
        cite: `inbox ${item.id}`,
        by: "human",
        ticket: item.ticket,
        paths: asArray(plan.byId.get(item.ticket)?.data.touches),
        question: item.question?.text,
      });
    }
    entry.pendingResume = { answer: text, findings, question: item.question, from: "human" };
    setStage(root, slug, state, item.ticket, "queued", { reason: "answered by a person" });
    saveState(root, slug, state);
    return { ok: true };
  }
  if (type === "campaign.save") {
    const file = campaignFile(root, slug);
    const text = readText(file, null);
    if (text === null) throw new UserError(`No campaign "${slug}"`);
    const { data, body } = splitFrontmatter(text);
    const patch = command.patch || {};
    if (patch.quotas) {
      const checked = validateQuotas(patch.quotas);
      if (checked.errors.length) throw new UserError(`Invalid quotas: ${checked.errors.join("; ")}`);
      patch.quotas = checked.quotas;
    }
    fs.writeFileSync(file, joinFrontmatter({ ...data, ...patch }, command.body ?? body));
    return { ok: true };
  }
  if (type === "promote") {
    const promoted = promoteDecision(root, slug, command.id);
    if (!promoted) throw new UserError(`No decision "${command.id}" in ${slug}`);
    appendEvent(root, { campaign: slug, type: "decision.promoted", data: { id: command.id, text: promoted.text } });
    return { ok: true };
  }
  if (type === "campaign.create") {
    const created = createCampaign({
      root,
      goal: command.goal,
      slug: command.slug,
      autonomy: command.autonomy,
      planGate: command.planGate,
      landing: command.landing,
      base: command.base,
    });
    appendEvent(root, { campaign: created.slug, type: "campaign.created", data: { file: created.file } });
    return { ok: true, ...created };
  }
  if (type === "ticket.edit") {
    const state = loadState(root, slug);
    const id = String(command.ticket).padStart(2, "0");
    if (state.tickets[id]?.stage === "working") throw new UserError(`Ticket ${id} is running`, ["Pause it first."]);
    const edited = editTicket({ root, slug, id, patch: command.patch || {} });
    appendEvent(root, { campaign: slug, ticket: id, type: "ticket.edited", data: { fields: Object.keys(command.patch || {}) } });
    return { ok: true, ticket: edited };
  }

  if (type === "ticket.remove") {
    const state = loadState(root, slug);
    const id = String(command.ticket).padStart(2, "0");
    if (state.tickets[id]?.stage === "working") throw new UserError(`Ticket ${id} is running`, ["Stop it first."]);
    const removed = removeTicket({ root, slug, id });
    delete state.tickets[id];
    saveState(root, slug, state);
    appendEvent(root, { campaign: slug, ticket: id, type: "ticket.removed", data: { file: removed.file } });
    return { ok: true, ticket: removed };
  }

  if (type === "cancel") {
    const state = loadState(root, slug);
    const stopped = [];
    for (const [runId, run] of Object.entries(state.runs)) {
      if (run.status !== "live") continue;
      killRun(run);
      run.status = "done";
      run.endedAt = nowIso();
      run.killed = "cancelled";
      saveRunRecord(root, slug, runId, { ...run });
      stopped.push(run.ticket);
    }
    state.slots = {};
    for (const [id, entry] of Object.entries(state.tickets)) {
      if (entry.stage === "working") setStage(root, slug, state, id, "queued", { reason: "campaign cancelled" });
    }
    campaignStage(root, slug, state, "paused", command.reason || "cancelled by a person");
    saveState(root, slug, state);
    writeStageToPlan(root, slug, "paused");
    appendEvent(root, { campaign: slug, type: "campaign.cancelled", data: { runs: stopped } });
    return { ok: true, stopped };
  }

  if (type === "archive") {
    const state = loadState(root, slug);
    const live = Object.values(state.runs).some((run) => run.status === "live");
    if (live) throw new UserError("A run is still alive", ["Cancel or wait for it first."]);
    if (!["delivered", "paused"].includes(state.stage)) {
      throw new UserError(`Only a delivered or paused campaign is archived (this one is ${state.stage})`);
    }
    campaignStage(root, slug, state, "archived");
    saveState(root, slug, state);
    writeStageToPlan(root, slug, "archived");
    return { ok: true };
  }

  if (type === "ticket.add") {
    const ticket = addTicket({
      root,
      slug,
      title: command.title,
      kind: command.kind,
      blockedBy: command.blocked_by,
      touches: command.touches,
      attachments: command.attachments,
      what: command.what,
      criteria: command.criteria,
    });
    appendEvent(root, { campaign: slug, ticket: ticket.id, type: "ticket.added", data: { file: ticket.file } });
    return { ok: true, ticket };
  }
  throw new UserError(`Unknown command "${type}"`);
}
