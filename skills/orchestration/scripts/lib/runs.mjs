// Spawning, tracking, and reading worker runs.
import fs from "node:fs";
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
  const file = path.join(runDir(root, slug, runId), "log.jsonl");
  const text = readText(file, "");
  if (!text) return { tokens: 0, dollars: 0, unmetered: true };
  let usage = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.usage && (event.usage.totalTokens || event.usage.cost)) usage = event.usage;
    } catch {
      // a partially written line is not a failure
    }
  }
  if (!usage) return { tokens: 0, dollars: 0, unmetered: true };
  return {
    tokens: usage.totalTokens || 0,
    dollars: usage.cost?.total || 0,
    unmetered: !usage.totalTokens && !usage.cost?.total,
  };
}

export function buildWorkerArgv({ run, modelEntry, thinking, tools, prompt, sessionsDir }) {
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
  if (tools && tools !== "default") argv.push("--tools", tools);
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
