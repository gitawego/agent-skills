import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SKILL } from "./helpers.mjs";

const SCRIPT = path.join(SKILL, "scripts", "report.mjs");

function report(args, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-report-"));
  const file = path.join(dir, "report.json");
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ORCH_REPORT: file, ...env },
  });
  return { res, file, body: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null };
}

test("a needs_answer report keeps its question, options and default", () => {
  const { res, body } = report([
    "--status",
    "needs_answer",
    "--summary",
    "half built",
    "--question",
    "Which order?",
    "--option",
    "up",
    "--option",
    "down",
    "--default",
    "up",
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(body.status, "needs_answer");
  assert.equal(body.question.text, "Which order?");
  assert.deepEqual(body.question.options, ["up", "down"]);
  assert.equal(body.question.default, "up");
});

test("checks and touched paths survive", () => {
  const { body } = report([
    "--status",
    "ready",
    "--summary",
    "done",
    "--check",
    "tests=ok",
    "--check",
    "lint=fail",
    "--touched",
    "src/a.ts",
  ]);
  assert.deepEqual(body.checks, [
    { name: "tests", ok: true },
    { name: "lint", ok: false },
  ]);
  assert.deepEqual(body.touched, ["src/a.ts"]);
});

test("an unknown status is refused", () => {
  const { res, body } = report(["--status", "looks-good", "--summary", "x"]);
  assert.equal(res.status, 1);
  assert.equal(body, null);
  assert.match(res.stderr, /unknown status/);
});

test("needs_answer without a question is refused", () => {
  const { res, body } = report(["--status", "needs_answer", "--summary", "x"]);
  assert.equal(res.status, 1);
  assert.equal(body, null);
  assert.match(res.stderr, /needs --question/);
});

test("an acceptance file is read and kept as structured evidence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-report-"));
  const acceptanceFile = path.join(dir, "acceptance.json");
  fs.writeFileSync(
    acceptanceFile,
    JSON.stringify([
      { criterion: "add prints added", status: "passed", evidence: "ran `node cli.mjs add x`" },
      { criterion: "list prints rows", status: "passed", evidence: "ran `node cli.mjs list`" },
    ]),
  );
  const { res, body } = report(["--status", "ready", "--summary", "both work", "--acceptance-file", acceptanceFile]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(body.acceptance.map((item) => item.criterion), ["add prints added", "list prints rows"]);
  assert.equal(body.acceptance[0].evidence, "ran `node cli.mjs add x`");
});

test("a malformed acceptance file is refused before a report is written", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-report-"));
  const acceptanceFile = path.join(dir, "acceptance.json");
  fs.writeFileSync(
    acceptanceFile,
    JSON.stringify([
      { criterion: "add prints added", status: "looks-fine" },
      { criterion: "add prints added", status: "passed" },
    ]),
  );
  const { res, body } = report(["--status", "ready", "--summary", "x", "--acceptance-file", acceptanceFile]);
  assert.equal(res.status, 1);
  assert.equal(body, null);
  assert.match(res.stderr, /status must be "passed" or "failed"/);
  assert.match(res.stderr, /duplicate acceptance result/);
});

test("a findings file is read and invalid severities are refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-report-"));
  const good = path.join(dir, "findings.json");
  fs.writeFileSync(
    good,
    JSON.stringify([
      { id: "F1", severity: "blocker", file: "src/cli.ts", line: 42, problem: "argv is sliced twice", requiredFix: "slice once" },
    ]),
  );
  const ok = report(["--status", "failed", "--summary", "one blocker", "--findings-file", good]);
  assert.equal(ok.res.status, 0, ok.res.stderr);
  assert.equal(ok.body.findings[0].severity, "blocker");
  assert.equal(ok.body.findings[0].line, 42);

  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify([{ id: "F1", severity: "critical", problem: "x", requiredFix: "y" }]));
  const refused = report(["--status", "failed", "--summary", "x", "--findings-file", bad]);
  assert.equal(refused.res.status, 1);
  assert.match(refused.res.stderr, /severity must be one of low, medium, high, blocker/);
});

test("a report with no destination is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-report-"));
  const res = spawnSync(process.execPath, [SCRIPT, "--status", "ready", "--summary", "x"], {
    encoding: "utf8",
    env: { ...process.env, ORCH_REPORT: "", },
    cwd: dir,
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no report path/);
});
