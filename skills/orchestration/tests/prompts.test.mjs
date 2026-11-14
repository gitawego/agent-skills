import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workerPrompt, reviewPrompt, judgePrompt, mergePrompt, systemPromptFiles, systemPromptDigest, promptDigest, promptAudit } from "../scripts/lib/prompts.mjs";

const TICKET = {
  what: "Build the thing.",
  criteria: [{ text: "The thing works." }],
  touches: ["src/thing/**"],
};

test("every role has a contract file and the contract comes first", () => {
  for (const role of ["code", "design", "visual", "research", "plan", "chores", "review", "judge", "merge"]) {
    const files = systemPromptFiles(role);
    assert.equal(files.length, 2);
    assert.match(files[0], /references\/contract\.md$/);
    assert.match(files[1], new RegExp(`references/roles/${role}\\.md$`));
    for (const file of files) assert.ok(fs.existsSync(file), `${file} exists`);
  }
});

test("the contract tells workers to hand a bounded packet to a subagent", () => {
  const text = fs.readFileSync(systemPromptFiles("code")[0], "utf8");
  assert.match(text, /Delegating to a subagent/);
  assert.match(text, /bounded context packet/);
  assert.match(text, /do-not-recheck/);
  assert.match(text, /never your transcript/);
});

test("a custom kind falls back to the general role", () => {
  const files = systemPromptFiles("docs");
  assert.match(files[1], /roles\/general\.md$/);
});

test("the worker prompt interpolates every placeholder", () => {
  const text = workerPrompt({
    campaign: "demo",
    ticket: "03",
    ticketTitle: "The thing",
    runId: "r-1",
    workdir: "/tmp/wt",
    base: "main",
    kind: "code",
    decisions: [],
    sections: { brief: "Because.", constraints: "None." },
    data: TICKET,
  });
  assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/);
  assert.match(text, /kind: code/);
});

test("a dependent ticket receives the completed blocker's outcome and evidence", () => {
  const text = workerPrompt({
    campaign: "demo",
    ticket: "02",
    ticketTitle: "Use the store",
    runId: "r-2",
    workdir: "/tmp/wt",
    base: "main",
    kind: "code",
    decisions: [],
    sections: { brief: "Because.", constraints: "None." },
    data: TICKET,
    dependencies: [
      {
        id: "01",
        title: "Storage slice",
        summary: "Added the file store and its append/read API.",
        touched: ["src/store/store.mjs"],
        checks: [{ name: "npm test -- store", ok: true }],
        next: "Wire the CLI to the store API.",
        acceptance: [
          { criterion: "A note survives a restart", status: "passed", evidence: "ran the store test" },
        ],
      },
    ],
  });
  assert.match(text, /## Completed blockers/);
  assert.match(text, /01 Storage slice/);
  assert.match(text, /Added the file store/);
  assert.match(text, /src\/store\/store\.mjs/);
  assert.match(text, /checks already run \(worker report\): npm test -- store \(pass\)/);
  assert.match(text, /handoff: Wire the CLI/);
  assert.match(text, /A note survives a restart/);
  assert.match(text, /not authority to widen this ticket/);
});

test("long dependency context and decisions are clipped, not silently dropped", () => {
  const text = workerPrompt({
    campaign: "demo",
    ticket: "02",
    ticketTitle: "Use the store",
    runId: "r-2",
    workdir: "/tmp/wt",
    base: "main",
    kind: "code",
    decisions: Array.from({ length: 20 }, (_, index) => ({
      text: `Decision ${index} ${"x".repeat(900)}`,
      cite: `source-${index}`,
    })),
    sections: { brief: "b".repeat(7000), constraints: "c".repeat(5000) },
    data: TICKET,
    dependencies: [
      {
        id: "01",
        title: "Storage slice",
        summary: "s".repeat(2000),
        touched: ["src/store/store.mjs"],
        checks: [],
        acceptance: [{ criterion: "A note survives", status: "passed", evidence: "e".repeat(1200) }],
      },
    ],
  });
  assert.match(text, /truncated/);
  assert.match(text, /older decisions omitted/);
  assert.ok(text.length < 25_000, `prompt remained too large: ${text.length}`);
});

test("a ticket with no completed blockers says so instead of inventing one", () => {
  const text = workerPrompt({
    campaign: "demo",
    ticket: "01",
    ticketTitle: "First",
    runId: "r-1",
    workdir: "/tmp/wt",
    base: "main",
    kind: "code",
    decisions: [],
    sections: { brief: "Because." },
    data: TICKET,
  });
  assert.match(text, /No completed blockers/);
});

test("the review prompt names the diff to read instead of leaving a placeholder", () => {
  const text = reviewPrompt({
    campaign: "demo",
    ticket: "03",
    ticketTitle: "The thing",
    runId: "r-1",
    workdir: "/tmp/wt",
    base: "main",
    kind: "code",
    data: TICKET,
    landing: "branch",
  });
  assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/);
  assert.match(text, /git diff --stat main\.\.\.HEAD/);
  assert.match(text, /git diff main\.\.\.HEAD/);
});

test("the judge and merge prompts interpolate every placeholder", () => {
  const judge = judgePrompt({
    campaign: "demo",
    ticket: "03",
    ticketTitle: "The thing",
    question: { text: "Which one?" },
    summary: "Tried both.",
    sections: {},
    data: TICKET,
    decisions: [],
  });
  assert.doesNotMatch(judge, /\{\{[A-Z_]+\}\}/);
  const merge = mergePrompt({ root: "/tmp/wt", slug: "demo", ticket: "03", conflict: "CONFLICT (content)" });
  assert.doesNotMatch(merge, /\{\{[A-Z_]+\}\}/);
  assert.match(merge, /CONFLICT \(content\)/);
});

test("prompt cost is recorded, including dependency and decision weight", () => {
  const audit = promptAudit("abcd".repeat(250), {
    dependencies: [{ id: "01", summary: "done" }],
    decisions: [{ text: "reuse the filter" }],
  });
  assert.equal(audit.promptChars, 1000);
  assert.equal(audit.promptTokensEstimate, 250);
  assert.equal(audit.dependencyCount, 1);
  assert.equal(audit.decisionCount, 1);
  assert.ok(audit.dependencyChars > 0);
  assert.ok(audit.decisionChars > 0);
});

test("the prompt digest is stable and content-addressed", () => {
  assert.equal(promptDigest("a"), promptDigest("a"));
  assert.notEqual(promptDigest("a"), promptDigest("b"));
  assert.match(promptDigest("a"), /^[a-f0-9]{64}$/);
});

test("the system prompt digest changes with the role, not the path", () => {
  const code = systemPromptDigest(systemPromptFiles("code"));
  const design = systemPromptDigest(systemPromptFiles("design"));
  assert.match(code, /^[a-f0-9]{64}$/);
  assert.notEqual(code, design);
});
