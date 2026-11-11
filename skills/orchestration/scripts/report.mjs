#!/usr/bin/env node
// The only way a worker finishes: one schema-validated report file.
import fs from "node:fs";
import path from "node:path";
import { normalizeAcceptance, normalizeFindings } from "./lib/evidence.mjs";

const STATUSES = ["progress", "ready", "needs_answer", "blocked", "failed", "dropped"];

function parse(argv) {
  const out = { options: [], touched: [], checks: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=");
    const value = inline != null ? inline : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "";
    if (key === "option") out.options.push(value);
    else if (key === "touched") out.touched.push(value);
    else if (key === "check") {
      const [name, result = "ok"] = value.split("=");
      out.checks.push({ name, ok: result !== "fail" && result !== "false" });
    } else out[key] = value;
  }
  return out;
}

function die(message) {
  console.error(`report: ${message}`);
  console.error("");
  console.error("  report.mjs --status ready --summary \"What is now true.\"");
  console.error("  report.mjs --status ready --summary \"...\" --acceptance-file /tmp/acceptance.json");
  console.error("  report.mjs --status failed --summary \"...\" --findings-file /tmp/findings.json");
  console.error("  report.mjs --status needs_answer --summary \"...\" --question \"Which of these two?\" --option A --option B --default A");
  process.exit(1);
}

function readJsonArray(file, label) {
  if (!file) die(`${label} needs a file path`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    die(`${label}: ${err.message}`);
  }
  if (!Array.isArray(parsed)) die(`${label} must be a JSON array`);
  return parsed;
}

const args = parse(process.argv.slice(2));
if (!args.status) die("--status is required");
if (!STATUSES.includes(args.status)) die(`unknown status "${args.status}" (one of ${STATUSES.join(", ")})`);
if (!args.summary) die("--summary is required and must say what is now true, not what you did");
if (args.status === "needs_answer" && !args.question) die("needs_answer needs --question");

const report = {
  status: args.status,
  summary: args.summary,
  writtenAt: new Date().toISOString(),
};
if (args.question) {
  report.question = { text: args.question };
  if (args.options?.length) report.question.options = args.options;
  if (args.default) report.question.default = args.default;
}
if (args.next) report.next = args.next;
if (args.touched.length) report.touched = args.touched;
if (args.checks.length) report.checks = args.checks;
if (args["acceptance-file"]) {
  const acceptance = normalizeAcceptance(readJsonArray(args["acceptance-file"], "acceptance-file"));
  if (acceptance.errors.length) die(`invalid acceptance: ${acceptance.errors.join("; ")}`);
  report.acceptance = acceptance.results;
}
if (args["findings-file"]) {
  const findings = normalizeFindings(readJsonArray(args["findings-file"], "findings-file"));
  if (findings.errors.length) die(`invalid findings: ${findings.errors.join("; ")}`);
  report.findings = findings.findings;
}

const file = args.file || process.env.ORCH_REPORT;
if (!file) die("no report path: set ORCH_REPORT (the supervisor does) or pass --file");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
console.log(`report written: ${file} (${report.status})`);
