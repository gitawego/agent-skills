import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, project, writeConsole, writeCampaign, writeTicket, commitAll, scenario, sleep, MODELS } from "./helpers.mjs";
import {
  appendDecision,
  decisionsFor,
  findAnswer,
  promoteDecision,
  readDecisions,
  questionHash,
  retireMissingPaths,
} from "../scripts/lib/memory.mjs";
import { campaignDecisionsFile, consoleStateDir } from "../scripts/lib/util.mjs";
import { tick, applyCommand } from "../scripts/lib/engine.mjs";
import { campaignView } from "../scripts/lib/view.mjs";
import { loadConsole } from "../scripts/lib/config.mjs";
import { listItems } from "../scripts/lib/inbox.mjs";

const BODY = `## Goal\n\nShip it.\n\n## Brief\n\nB.\n\n## Acceptance criteria\n\n- [ ] ok\n\n## Constraints\n\nThe order is oldest first.\n\n## What to read first\n\n- **Files:** README.md\n`;

function ready(summary, criteria = ["The file exists."]) {
  return {
    status: "ready",
    summary,
    acceptance: criteria.map((criterion) => ({ criterion, status: "passed", evidence: `fixture: ${criterion}` })),
  };
}

function setup({ tickets = 1 } = {}) {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  writeCampaign(
    dir,
    "demo",
    {
      campaign: "demo",
      stage: "running",
      autonomy: "trusted",
      plan_gate: "human",
      landing: "branch",
      base: "main",
      checks: [{ name: "always", cmd: "true" }],
      budget: { tokens: null, dollars: null },
      max_autoship_lines: 200,
      kinds: {
        code: { models: [{ model: MODELS.strong, thinking: "high" }] },
        review: { models: [{ model: MODELS.backup, thinking: "high" }] },
        plan: { models: [{ model: MODELS.strong, thinking: "high" }] },
      },
    },
    BODY,
  );
  for (let i = 1; i <= tickets; i++) {
    writeTicket(
      dir,
      "demo",
      `0${i}-t${i}.md`,
      { id: `0${i}`, kind: "code", touches: [`work-0${i}.txt`] },
      `## What to build\n\nFile ${i}.\n\n## Acceptance criteria\n\n- [ ] The file exists.`,
    );
  }
  commitAll(dir);
  return { dir, slug: "demo" };
}

async function until(root, slug, predicate, { ticks = 120, wait = 60 } = {}) {
  for (let i = 0; i < ticks; i++) {
    tick({ root });
    const view = campaignView(root, slug);
    if (predicate(view)) return view;
    await sleep(wait);
  }
  const view = campaignView(root, slug);
  throw new Error(`did not settle: ${view.tickets.map((t) => `${t.id}:${t.stage}`).join(" ")} inbox=${view.inbox.length}`);
}

test("a decision records the question, the paths and a hash of the ask", () => {
  const { dir, slug } = setup();
  const decision = appendDecision(dir, slug, {
    text: "Backfill oldest first.",
    cite: "campaign.md § Constraints",
    by: "human",
    ticket: "01",
    paths: ["src/store.mjs"],
    question: "Which  backfill ORDER?",
  });
  assert.match(decision.id, /^d-[0-9a-f]{8}$/);
  assert.equal(decision.questionHash, questionHash("which backfill order"));
  const stored = readDecisions(dir, slug);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, "Backfill oldest first.");
});

test("a repeated question is answered from memory, and a reworded one is not", () => {
  const { dir, slug } = setup();
  appendDecision(dir, slug, { text: "Oldest first.", by: "human", question: "Which backfill order?" });
  assert.ok(findAnswer(dir, slug, "which   backfill order?"));
  assert.equal(findAnswer(dir, slug, "Should the backfill run newest first?"), null);
});

test("a reworded question still finds the answer, a different one does not", () => {
  const { dir, slug } = setup();
  appendDecision(dir, slug, { text: "Oldest first.", by: "human", question: "Which migration order should the backfill use?" });
  assert.ok(findAnswer(dir, slug, "What order should the migration backfill use?"), "the same ask, reworded");
  assert.equal(findAnswer(dir, slug, "Which migration tool should the import use?"), null, "a different subject");
  assert.equal(findAnswer(dir, slug, "Is the backfill fast?"), null, "too little to judge");
});

test("identical paths and identical questions supersede, mere overlap does not", () => {
  const { dir, slug } = setup();
  const first = appendDecision(dir, slug, { text: "one", paths: ["src/api/x.ts"] });
  appendDecision(dir, slug, { text: "two", paths: ["src/api/x.ts"] });
  const active = readDecisions(dir, slug);
  assert.equal(active.length, 1, "same paths retire the older claim");
  assert.equal(active[0].text, "two");
  const all = readDecisions(dir, slug, { includeSuperseded: true });
  assert.equal(all.find((r) => r.id === first.id).supersededBy !== null, true);

  appendDecision(dir, slug, { text: "three", paths: ["src/**"] });
  assert.equal(readDecisions(dir, slug).length, 2, "a broader claim is not a replacement");
});

test("a worker only gets the decisions that touch its paths", () => {
  const { dir, slug } = setup();
  appendDecision(dir, slug, { text: "api rule", paths: ["src/api/**"] });
  appendDecision(dir, slug, { text: "docs rule", paths: ["docs/**"] });
  appendDecision(dir, slug, { text: "general rule", paths: [] });
  const forApi = decisionsFor(dir, slug, ["src/api/users.ts"]).map((d) => d.text);
  assert.deepEqual(forApi.sort(), ["api rule", "general rule"]);
});

test("a decision about paths that no longer exist is retired at delivery", () => {
  const { dir, slug } = setup();
  fs.writeFileSync(path.join(dir, "work-01.txt"), "here\n");
  appendDecision(dir, slug, { text: "the old store keeps order", paths: ["src/gone/**"] });
  appendDecision(dir, slug, { text: "the live store keeps order", paths: ["work-01.txt"] });
  const retired = retireMissingPaths(dir, slug);
  assert.equal(retired.length, 1);
  assert.equal(retired[0].text, "the old store keeps order");
  const active = readDecisions(dir, slug);
  assert.deepEqual(active.map((d) => d.text), ["the live store keeps order"]);
  assert.equal(readDecisions(dir, slug, { includeSuperseded: true }).find((d) => d.text === "the old store keeps order").supersededBy, "paths-removed");
});

test("promoting a decision copies it to the console log and keeps a mark", () => {
  const { dir, slug } = setup();
  const decision = appendDecision(dir, slug, { text: "muse reports zero usage", paths: [] });
  const promoted = promoteDecision(dir, slug, decision.id);
  assert.ok(promoted.promoted);
  const shared = fs.readFileSync(path.join(consoleStateDir(), "decisions.jsonl"), "utf8");
  assert.match(shared, /muse reports zero usage/);
  const all = readDecisions(dir, slug);
  assert.equal(all.filter((d) => d.text === "muse reports zero usage").length, 2, "one local, one shared");
});

test("the engine answers a repeated question without spending a judge run", async () => {
  const { dir, slug } = setup();
  appendDecision(dir, slug, {
    text: "Oldest first.",
    cite: "campaign.md § Constraints",
    by: "human",
    question: "Which backfill order?",
  });
  scenario({
    work: [{ status: "needs_answer", summary: "half", question: { text: "Which backfill order?" } }, ready("rest")],
    judge: [],
    review: [ready("clean")],
  });
  const view = await until(dir, slug, (v) => v.tickets[0].stage === "done");
  assert.equal(view.runs.filter((r) => r.role === "judge").length, 0, "no judge was asked");
  assert.equal(view.inbox.filter((i) => i.kind === "question").length, 0);
});

test("a human answer becomes a decision, so the next ticket can cite it", async () => {
  const { dir, slug } = setup();
  scenario({
    work: [{ status: "needs_answer", summary: "half", question: { text: "Which backfill order?" } }, ready("rest")],
    judge: [{ status: "blocked", summary: "no source" }],
    review: [ready("clean")],
  });
  await until(dir, slug, (v) => v.inbox.some((i) => i.kind === "question"));
  const item = listItems(dir, slug, { status: "open" }).find((i) => i.kind === "question");
  applyCommand(dir, { type: "answer", campaign: slug, item: item.id, text: "Oldest first." }, loadConsole());
  const decisions = readDecisions(dir, slug);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].by, "human");
  assert.equal(decisions[0].text, "Oldest first.");
  assert.deepEqual(decisions[0].paths, ["work-01.txt"]);
  assert.ok(decisions[0].questionHash);
});

test("the judge's cited answer is written down too", async () => {
  const { dir, slug } = setup();
  scenario({
    work: [{ status: "needs_answer", summary: "half", question: { text: "Which backfill order?" } }, ready("rest")],
    judge: [{ status: "ready", summary: "Oldest first.", next: "cite: campaign.md § Constraints" }],
    review: [ready("clean")],
  });
  await until(dir, slug, (v) => v.tickets[0].stage === "done");
  const decisions = readDecisions(dir, slug);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].by, "orchestrator");
  assert.match(decisions[0].cite, /^cite:/);
});

test("delivery leaves a close report with the tickets and the decisions", async () => {
  const { dir, slug } = setup();
  appendDecision(dir, slug, { text: "Oldest first.", cite: "campaign.md", by: "human", paths: [] });
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  await until(dir, slug, (v) => v.stage === "delivered");
  const file = path.join(dir, "orchestration", slug, "CLOSE.md");
  assert.ok(fs.existsSync(file));
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /demo — close/);
  assert.match(text, /\| 01 \| t1 \| code \| done \| 1 \| 0 \|/);
  assert.match(text, /Oldest first\./);
  assert.match(text, /Nothing needed a second try/);
});

test("a diff outside the declared paths is sent back with the file named", async () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  writeCampaign(
    dir,
    "demo",
    {
      campaign: "demo",
      stage: "running",
      autonomy: "trusted",
      plan_gate: "human",
      landing: "branch",
      base: "main",
      checks: [{ name: "always", cmd: "true" }],
      budget: { tokens: null, dollars: null },
      max_autoship_lines: 200,
      kinds: { code: { models: [{ model: MODELS.strong, thinking: "high" }] }, review: { models: [{ model: MODELS.backup, thinking: "high" }] } },
    },
    BODY,
  );
  writeTicket(
    dir,
    "demo",
    "01-t.md",
    { id: "01", kind: "code", touches: ["src/**"] },
    "## What to build\n\nSomething.\n\n## Acceptance criteria\n\n- [ ] It exists.",
  );
  commitAll(dir);
  scenario({
    work: [
      ready("one", ["It exists."]),
      ready("two", ["It exists."]),
      ready("three", ["It exists."]),
    ],
    review: [],
  });
  const view = await until(dir, "demo", (v) => v.tickets[0].stage === "failed");
  const findings = view.inbox.find((i) => i.kind === "failure")?.findings || "";
  assert.match(findings, /work-01\.txt/, "the escaped file is named");
  const events = fs.readFileSync(path.join(dir, ".orchestration", "events.jsonl"), "utf8");
  assert.match(events, /leaves the paths this ticket declared/);
});
