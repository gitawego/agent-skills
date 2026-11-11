import test from "node:test";
import assert from "node:assert/strict";
import {
  blockingFindings,
  canonicalCriterion,
  coverageOf,
  formatCoverage,
  normalizeCriteria,
  normalizeFindings,
  protectedPathReason,
  validateAcceptance,
  validateReviewReport,
} from "../scripts/lib/evidence.mjs";

test("criteria are unique after whitespace normalization", () => {
  const result = normalizeCriteria(["  Add   prints added ", "List prints rows"]);
  assert.deepEqual(result.criteria, ["Add prints added", "List prints rows"]);
  const duplicate = normalizeCriteria(["Add prints added", "Add  prints added"]);
  assert.deepEqual(duplicate.duplicates, ["Add prints added"]);
});

test("coverage names claimed and missing criteria without inventing a ticket", () => {
  const coverage = coverageOf({
    criteria: ["Add works", "List works", "No new dependency"],
    tickets: [
      { key: "add", covers: ["Add works"] },
      { key: "list", covers: ["List works", "Add works"] },
    ],
  });
  assert.equal(coverage.total, 3);
  assert.equal(coverage.claimed, 2);
  assert.deepEqual(coverage.missing, ["No new dependency"]);
  assert.deepEqual(coverage.matrix[0], { criterion: "Add works", tickets: ["add", "list"] });
  assert.equal(formatCoverage(coverage), "coverage: 2/3 criteria claimed; missing: No new dependency");
});

test("acceptance must match every ticket criterion exactly once", () => {
  const criteria = ["add prints added", "list prints rows"];
  const valid = validateAcceptance({
    criteria,
    acceptance: [
      { criterion: " add prints added ", status: "passed", evidence: "ran it" },
      { criterion: "list prints rows", status: "passed", evidence: "ran it" },
    ],
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.results.map((item) => item.criterion), criteria);

  const missing = validateAcceptance({ criteria, acceptance: [{ criterion: "add prints added", status: "passed" }] });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(" "), /missing acceptance result for "list prints rows"/);

  const unknown = validateAcceptance({
    criteria,
    acceptance: [
      { criterion: "add prints added", status: "passed" },
      { criterion: "list prints rows", status: "passed" },
      { criterion: "something else", status: "passed" },
    ],
  });
  assert.match(unknown.errors.join(" "), /unknown criterion "something else"/);

  const duplicate = validateAcceptance({
    criteria,
    acceptance: [
      { criterion: "add prints added", status: "passed" },
      { criterion: "add prints added", status: "passed" },
      { criterion: "list prints rows", status: "passed" },
    ],
  });
  assert.match(duplicate.errors.join(" "), /duplicate acceptance result/);

  const failedAsReady = validateAcceptance({
    criteria,
    acceptance: [
      { criterion: "add prints added", status: "failed", evidence: "exit 1" },
      { criterion: "list prints rows", status: "passed" },
    ],
  });
  assert.match(failedAsReady.errors.join(" "), /ready requires every acceptance result to be passed/);
});

test("a failed report may carry failed acceptance results", () => {
  const result = validateAcceptance({
    criteria: ["add prints added"],
    acceptance: [{ criterion: "add prints added", status: "failed", evidence: "exit 1" }],
    allowPartial: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].status, "failed");
});

test("findings are structured and review status must match their severity", () => {
  const good = normalizeFindings([
    { id: "F1", severity: "blocker", problem: "argv is sliced twice", requiredFix: "slice once", file: "src/cli.ts", line: 42 },
    { id: "F2", severity: "low", problem: "naming", requiredFix: "rename" },
  ]);
  assert.equal(good.errors.length, 0);
  assert.equal(blockingFindings(good.findings).length, 1);

  const readyWithBlocker = validateReviewReport({
    status: "ready",
    findings: [{ id: "F1", severity: "blocker", problem: "wrong", requiredFix: "fix" }],
  });
  assert.match(readyWithBlocker.errors.join(" "), /ready cannot carry high or blocker/);

  const failedWithoutBlocker = validateReviewReport({
    status: "failed",
    findings: [{ id: "F1", severity: "medium", problem: "style", requiredFix: "tidy" }],
  });
  assert.match(failedWithoutBlocker.errors.join(" "), /failed review needs at least one high or blocker/);

  const lowOnPass = validateReviewReport({
    status: "ready",
    findings: [{ id: "F1", severity: "low", problem: "naming", requiredFix: "rename" }],
  });
  assert.equal(lowOnPass.ok, true);
});

test("review findings reject unknown severities and missing required fields", () => {
  const result = normalizeFindings([{ id: "F1", severity: "critical", problem: "x" }]);
  assert.match(result.errors.join(" "), /severity must be one of low, medium, high, blocker/);
  assert.match(result.errors.join(" "), /requiredFix is required/);
});

test("protected paths cover supervisor state, secrets, and the campaign plan", () => {
  for (const path of [
    ".git/config",
    ".orchestration/campaigns/demo/state.json",
    ".env",
    ".env.local",
    "secrets/token.txt",
    "keys/id_rsa",
    "orchestration/demo/tickets/01.md",
  ]) {
    assert.ok(protectedPathReason(path, "demo"), `${path} is protected`);
  }
  assert.equal(protectedPathReason("src/cli.ts", "demo"), null);
  assert.equal(protectedPathReason("docs/notes.md", "demo"), null);
});

test("covers entries canonicalize whitespace and unknown criteria are reported by normalizePlan", async () => {
  const { normalizePlan } = await import("../scripts/lib/plan-import.mjs");
  const base = {
    goal: "G",
    brief: "B",
    assumptions: [],
    criteria: ["Add  works", "List works"],
    tickets: [
      {
        key: "add",
        title: "Add",
        kind: "code",
        touches: ["src/**"],
        what: "Do it.",
        accept: ["Done"],
        covers: [" Add works "],
      },
    ],
  };
  const plan = normalizePlan(base);
  assert.deepEqual(plan.criteria, ["Add works", "List works"]);
  assert.deepEqual(plan.tickets[0].covers, ["Add works"]);
  assert.throws(
    () => normalizePlan({ ...base, tickets: [{ ...base.tickets[0], covers: ["Unknown"] }] }),
    /unknown campaign criterion/,
  );
  assert.throws(
    () => normalizePlan({ ...base, criteria: ["Same", "Same"] }),
    /duplicate campaign criterion/,
  );
});

test("canonicalCriterion only changes whitespace, never meaning", () => {
  assert.equal(canonicalCriterion("  a   b  "), "a b");
  assert.equal(canonicalCriterion("a\tb\nc"), "a b c");
});
