// Spawning, tracking, and reading worker runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  REPORT_SCRIPT,
  ensureDir,
  exists,
  nowIso,
  readJson,
  readText,
  tail,
  truncate,
} from "./util.mjs";
import { runDir, saveRunRecord } from "./state.mjs";

export function newRunId(ticketId, role, attempt) {
  const ts = nowIso().replace(/[-:]/g, "").replace("Z", "");
  return `r-${ts}-${ticketId || "gate"}-${role}${attempt ? `-${attempt}` : ""}`.replace(/[^A-Za-z0-9._-]/g, "");
}

export function sessionIdFor(slug, ticketId, role) {
  const base = role === "work" ? `orch-${slug}-${ticketId}` : `orch-${slug}-${role}-${ticketId}`;
  return base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
}

export function validateReport(report) {
  const errors = [];
  if (!report || typeof report !== "object") return ["report is not an object"];
  const allowed = new Set(["progress", "ready", "needs_answer", "blocked", "failed", "dropped"]);
  if (!allowed.has(report.status)) errors.push(`unknown status "${report.status}"`);
  if (typeof report.summary !== "string" || !report.summary.trim()) errors.push("summary is empty");
  if (report.status === "needs_answer" && !(report.question && String(report.question.text || "").trim()))
    errors.push("needs_answer without question.text");
  if (report.checks && !Array.isArray(report.checks)) errors.push("checks must be an array");
  if (report.touched && !Array.isArray(report.touched)) errors.push("touched must be an array");
  return errors;
}

export function readReport(root, slug, runId) {
  return readJson(path.join(runDir(root, slug, runId), "report.json"), null);
}

export function readLogTail(root, slug, runId, lines = 40) {
  const file = path.join(runDir(root, slug, runId), "log.jsonl");
  return tail(readText(file, ""), lines);
}

export function usageFromLog(root, slug, runId) {
  const session = readJson(path.join(runDir(root, slug, runId), "session.json"), null);
  if (session?.usage) {
    const usage = session.usage;
    const inputTokens = usage.inputTokens || 0;
    const outputTokens = usage.outputTokens || 0;
    const cachedReadTokens = usage.cachedReadTokens || 0;
    const cachedWriteTokens = usage.cachedWriteTokens || 0;
    const thoughtTokens = usage.thoughtTokens || 0;
    return {
      tokens: usage.totalTokens || inputTokens + outputTokens + cachedReadTokens + thoughtTokens,
      dollars: 0,
      unmetered: true,
      inputTokens,
      outputTokens,
      cachedReadTokens,
      cachedWriteTokens,
      thoughtTokens,
      costFromProvider: null,
      source: "session",
    };
  }
  const file = path.join(runDir(root, slug, runId), "log.jsonl");
  const text = readText(file, "");
  if (!text) return { tokens: 0, dollars: 0, unmetered: true, source: "none" };
  let usage = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed);
      const candidate = event.usage || event.update?.usage || null;
      if (candidate && (candidate.totalTokens || candidate.cost || candidate.input || candidate.inputTokens))
        usage = candidate;
    } catch {
      // a partially written line is not a failure
    }
  }
  if (!usage) return { tokens: 0, dollars: 0, unmetered: true, source: "none" };
  const inputTokens = usage.input ?? usage.inputTokens ?? 0;
  const outputTokens = usage.output ?? usage.outputTokens ?? 0;
  const cachedReadTokens = usage.cacheRead ?? usage.cachedReadTokens ?? 0;
  const cachedWriteTokens = usage.cacheWrite ?? usage.cachedWriteTokens ?? 0;
  const thoughtTokens = usage.thought ?? usage.thoughtTokens ?? 0;
  const totalTokens = usage.totalTokens || inputTokens + outputTokens + cachedReadTokens + thoughtTokens;
  const dollars = usage.cost?.total || 0;
  return {
    tokens: totalTokens,
    dollars,
    unmetered: !totalTokens && !dollars,
    inputTokens,
    outputTokens,
    cachedReadTokens,
    cachedWriteTokens,
    thoughtTokens,
    costFromProvider:
      usage.cost && typeof usage.cost.totalFromProvider === "boolean" ? usage.cost.totalFromProvider : null,
    source: "log",
  };
}

/* Harnesses that expose subagents write them as normal log events or as a
   `children` list in session.json. Observation only: these are not tickets and
   the scheduler never sees them. */
export function childrenFromLog(root, slug, runId) {
  const dir = runDir(root, slug, runId);
  const session = readJson(path.join(dir, "session.json"), null);
  const found = new Map();
  const add = (raw, fallbackId = null) => {
    if (!raw || typeof raw !== "object") return;
    const id = String(raw.id || raw.sessionId || raw.runId || raw.childId || fallbackId || "").trim();
    if (!id) return;
    const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : raw;
    const inputTokens = Number(usage.inputTokens ?? usage.input ?? raw.inputTokens ?? 0) || 0;
    const outputTokens = Number(usage.outputTokens ?? usage.output ?? raw.outputTokens ?? 0) || 0;
    const cachedReadTokens = Number(usage.cachedReadTokens ?? usage.cacheRead ?? raw.cachedReadTokens ?? 0) || 0;
    const thoughtTokens = Number(usage.thoughtTokens ?? usage.thought ?? 0) || 0;
    const tokens =
      Number(usage.totalTokens ?? raw.tokens ?? 0) || inputTokens + outputTokens + cachedReadTokens + thoughtTokens;
    const dollars = Number(usage.dollars ?? usage.cost?.total ?? raw.dollars ?? 0) || 0;
    const previous = found.get(id) || {};
    found.set(id, {
      id,
      name: raw.name || raw.title || raw.label || previous.name || id,
      model: raw.model || raw.modelId || previous.model || null,
      status: raw.status || raw.state || previous.status || "reported",
      startedAt: raw.startedAt || previous.startedAt || null,
      endedAt: raw.endedAt || raw.completedAt || previous.endedAt || null,
      tokens: tokens || previous.tokens || 0,
      dollars: dollars || previous.dollars || 0,
      inputTokens: inputTokens || previous.inputTokens || 0,
      outputTokens: outputTokens || previous.outputTokens || 0,
      cachedReadTokens: cachedReadTokens || previous.cachedReadTokens || 0,
    });
  };
  for (const child of session?.children || session?.subagents || []) add(child);

  const text = readText(path.join(dir, "log.jsonl"), "");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed);
      const child =
        event.subagent ||
        event.child ||
        (typeof event.type === "string" && /(subagent|child[_-]?run|child)/i.test(event.type) ? event : null) ||
        (event.update && typeof event.update === "object" && /(subagent|child)/i.test(event.update.sessionUpdate || event.update.type || "")
          ? event.update
          : null);
      if (child) add(child, event.id || event.runId || null);
    } catch {
      // ignore a half-written line
    }
  }
  return [...found.values()];
}

export function rollupChildren(children) {
  return (children || []).reduce(
    (sum, child) => ({
      tokens: sum.tokens + Number(child.tokens || 0),
      dollars: sum.dollars + Number(child.dollars || 0),
      count: sum.count + 1,
    }),
    { tokens: 0, dollars: 0, count: 0 },
  );
}

export function buildWorkerArgv({ run, modelEntry, thinking, tools, prompt, sessionsDir, systemPrompts = [], attachments = [] }) {
  const argv = [
    "--print",
    "--mode",
    "json",
    "--session-id",
    run.sessionId,
    "--session-dir",
    sessionsDir,
    "--name",
    `orch ${run.campaign}/${run.ticket || run.role}`,
    "--model",
    `${modelEntry.provider}/${modelEntry.model}`,
    "--thinking",
    thinking,
  ];
  /* The contract is appended first, then the role; pi reads a path as file contents. */
  for (const file of systemPrompts) argv.push("--append-system-prompt", file);
  if (tools && tools !== "default") argv.push("--tools", tools);
  for (const item of attachments) argv.push(`@${item.absPath}`);
  argv.push(prompt);
  return argv;
}

export function startRun({ root, slug, run, argv, command = "pi", workdir, env = {} }) {
  const dir = runDir(root, slug, run.id);
  ensureDir(dir);
  const logFile = path.join(dir, "log.jsonl");
  const errFile = path.join(dir, "log.err");
  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(errFile, "a");
  const child = spawn(command, argv, {
    cwd: workdir,
    env: {
      ...process.env,
      ...env,
      ORCH_PROJECT: root,
      ORCH_CAMPAIGN: slug,
      ORCH_TICKET: run.ticket || "",
      ORCH_RUN: run.id,
      ORCH_RUN_DIR: dir,
      ORCH_REPORT: path.join(dir, "report.json"),
      ORCH_WORKDIR: workdir,
      ORCH_REPORT_CMD: `node ${REPORT_SCRIPT}`,
    },
    detached: true,
    stdio: ["ignore", out, err],
  });
  child.unref();
  const record = {
    ...run,
    status: "live",
    pid: child.pid,
    startedAt: nowIso(),
    host: os.hostname(),
    workdir,
    log: logFile,
    err: errFile,
  };
  saveRunRecord(root, slug, run.id, record);
  return record;
}

export function killRun(record) {
  if (!record?.pid) return false;
  try {
    process.kill(-record.pid, "SIGKILL");
    return true;
  } catch {
    try {
      process.kill(record.pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
}

export function runTimedOut(record, timeoutMin) {
  if (!record?.startedAt) return false;
  return Date.now() - Date.parse(record.startedAt) > timeoutMin * 60_000;
}

export function runStuck(record, stuckMin) {
  if (!record?.log || !exists(record.log) || !stuckMin) return false;
  const mtime = fs.statSync(record.log).mtimeMs;
  return Date.now() - mtime > stuckMin * 60_000;
}

export function summarizeRun(root, slug, runId) {
  const report = readReport(root, slug, runId);
  return {
    report,
    errors: report ? validateReport(report) : ["no report.json written"],
    logTail: truncate(readLogTail(root, slug, runId, 60), 4000),
    usage: usageFromLog(root, slug, runId),
  };
}

export function writePrompt(root, slug, runId, prompt) {
  const file = path.join(runDir(root, slug, runId), "prompt.md");
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, prompt);
  return file;
}
