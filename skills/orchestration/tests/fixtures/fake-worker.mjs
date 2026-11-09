#!/usr/bin/env node
// A deterministic worker for tests: it plays the next scripted report for its role.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const runId = process.env.ORCH_RUN || "";
const delay = Number(process.env.FAKE_DELAY_MS || 0);
if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
const role = runId.includes("-review")
  ? "review"
  : runId.includes("-judge")
    ? "judge"
    : runId.includes("-merge")
      ? "merge"
      : "work";
const project = process.env.ORCH_PROJECT;
const scenarioFile = process.env.FAKE_SCENARIO || path.join(project, ".fake-scenario.json");
const scenario = JSON.parse(fs.readFileSync(scenarioFile, "utf8"));
const queue = scenario[role] || [];
const entry = queue.shift() ?? { status: "failed", summary: `fake: no scripted ${role} report left` };
fs.writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2));

const report = { status: entry.status, summary: entry.summary || "fake summary" };
if (entry.question) report.question = entry.question;
if (entry.next) report.next = entry.next;
if (entry.touched) report.touched = entry.touched;
if (entry.checks) report.checks = entry.checks;

if (report.status === "ready" && role === "work") {
  const ticket = process.env.ORCH_TICKET;
  fs.writeFileSync(path.join(process.cwd(), `work-${ticket}.txt`), `${report.summary}\n`);
  try {
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync(
      "git",
      ["-c", "user.email=fake@example.com", "-c", "user.name=fake", "commit", "-m", `ticket ${ticket}: ${report.summary}`],
      { cwd: process.cwd() },
    );
  } catch {
    // nothing to commit is not a failure for the fixture
  }
}

const reportPath = process.env.ORCH_REPORT || path.join(process.env.ORCH_RUN_DIR, "report.json");
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
process.stdout.write(
  JSON.stringify({ type: "message_update", usage: { totalTokens: 100, cost: { total: 0.01 } } }) + "\n",
);
