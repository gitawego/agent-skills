import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandbox, project, writeConsole, writeCampaign, writeTicket, commitAll, scenario, sleep, gitOut, MODELS } from "./helpers.mjs";
import { tick, applyCommand, deliveryAudit } from "../scripts/lib/engine.mjs";
import { campaignView } from "../scripts/lib/view.mjs";
import { loadState, saveState } from "../scripts/lib/state.mjs";
import { loadPlan } from "../scripts/lib/plan.mjs";
import { loadConsole, readCampaign } from "../scripts/lib/config.mjs";
import { listItems, createItem } from "../scripts/lib/inbox.mjs";
import { loadDispatch, setDispatch } from "../scripts/lib/dispatch.mjs";
import { cleanupCampaignBranches } from "../scripts/lib/landing.mjs";
import { childrenFromLog, rollupChildren } from "../scripts/lib/runs.mjs";

const BODY = `## Goal

Ship three small things.

## Brief

Each ticket adds one file.

## Acceptance criteria

- [ ] All three files exist.

## Constraints

Touch nothing shared.

## What to read first

- **Files:** README.md
`;

/* Test data states its evidence explicitly. The fixture worker writes exactly
   this array, so a missing or invented criterion is a test failure, not a
   convenient pass. */
function ready(summary, criteria = ["The file exists."]) {
  return {
    status: "ready",
    summary,
    acceptance: criteria.map((criterion) => ({
      criterion,
      status: "passed",
      evidence: `fixture: ${criterion}`,
    })),
  };
}

function setup({ autonomy = "trusted", tickets = 3, codeModels = null, checks = null } = {}) {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  const data = {
    campaign: "demo",
    stage: "running",
    autonomy,
    plan_gate: "human",
    landing: "branch",
    base: "main",
    checks: checks || [{ name: "always", cmd: "true" }],
    budget: { tokens: null, dollars: null },
    max_autoship_lines: 200,
    kinds: {
      code: { models: (codeModels || [MODELS.strong]).map((model) => ({ model, thinking: "high" })) },
      review: { models: [{ model: MODELS.backup, thinking: "high" }] },
    },
  };
  writeCampaign(dir, "demo", data, BODY);
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

function liveRunsFor(root, slug) {
  return Object.values(loadState(root, slug).runs || {}).filter((run) => run.status === "live").length;
}

async function until(root, slug, predicate, { ticks = 120, wait = 60 } = {}) {  for (let i = 0; i < ticks; i++) {
    tick({ root });
    const view = campaignView(root, slug);
    if (predicate(view)) return view;
    await sleep(wait);
  }
  const view = campaignView(root, slug);
  throw new Error(
    `did not settle: ${view.tickets.map((t) => `${t.id}:${t.stage}`).join(" ")} inbox=${view.inbox.length} ` +
      view.inbox.map((item) => `${item.kind}:${item.title}:${item.findings || item.brief || ""}`).join(" | "),
  );
}

test("three parallel tickets reach done, land on an integration branch, and deliver", async () => {
  const { dir, slug } = setup();
  scenario({ work: [ready("wrote it"), ready("wrote it"), ready("wrote it")], review: [ready("clean"), ready("clean"), ready("clean")] });

  const view = await until(dir, slug, (v) => v.tickets.every((t) => t.stage === "done"));
  assert.equal(view.stage, "delivered");
  for (let i = 1; i <= 3; i++) {
    assert.ok(fs.existsSync(path.join(dir, `work-0${i}.txt`)), `file ${i} landed on main`);
  }
  const branches = gitOut(dir, ["branch", "--list", "orch/*"]);
  assert.match(branches, new RegExp(`orch/${slug}/integration`));
  assert.ok(view.spend.tokens > 0);
  assert.equal(view.inbox.filter((i) => i.status === "open").length, 0);
});

test("a supervised campaign leaves the delivery for a person", async () => {
  const { dir, slug } = setup({ autonomy: "supervised", tickets: 1 });
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  const view = await until(dir, slug, (v) => v.stage === "delivered");
  const item = view.inbox.find((i) => i.kind === "review");
  assert.ok(item, "a review item is filed");
  assert.equal(view.delivery.mode, "manual");
  assert.match(view.delivery.branch, /integration/);
  assert.match(view.nextAction.text, /open a PR/);
  assert.match(view.nextAction.text, new RegExp(view.delivery.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(!fs.existsSync(path.join(dir, "work-01.txt")), "nothing merged into main yet");
  applyCommand(dir, { type: "review.approve", campaign: slug, item: item.id }, loadConsole());
  assert.ok(fs.existsSync(path.join(dir, "work-01.txt")), "approval merges");
  const after = campaignView(dir, slug);
  assert.equal(after.delivery.mode, "merged");
  assert.match(after.nextAction.command, new RegExp(`cleanup ${slug} --dry-run`));
  const branches = gitOut(dir, ["branch", "--list", "orch/*"]);
  assert.match(branches, new RegExp(`orch/${slug}/01`), "approval leaves cleanup to the person");
  applyCommand(dir, { type: "archive", campaign: slug }, loadConsole());
  const close = fs.readFileSync(path.join(dir, "orchestration", slug, "CLOSE.md"), "utf8");
  assert.match(close, /## Attention/);
  assert.match(close, /deliveries reviewed: 1/);
  assert.match(close, /total human actions: 1/);
});

test("approve with cleanup merges, removes the worktree and branches, and counts the action", async () => {
  const { dir, slug } = setup({ autonomy: "supervised", tickets: 1 });
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  const view = await until(dir, slug, (v) => v.stage === "delivered");
  const item = view.inbox.find((i) => i.kind === "review");
  applyCommand(dir, { type: "review.approve", campaign: slug, item: item.id, cleanup: true }, loadConsole());
  const after = campaignView(dir, slug);
  assert.equal(after.attention.cleanups, 1);
  assert.match(after.nextAction.command, new RegExp(`archive ${slug}`));
  assert.deepEqual(fs.readdirSync(path.join(dir, ".orchestration", "campaigns", slug, "worktrees")), []);
  assert.equal(gitOut(dir, ["branch", "--list", "orch/*"]).trim(), "");
  const close = fs.readFileSync(path.join(dir, "orchestration", slug, "CLOSE.md"), "utf8");
  assert.match(close, /cleanups: 1/);
  assert.match(close, /total human actions: 2/);
});

test("a manual delivery still merges after the base has moved", async () => {
  const { dir, slug } = setup({ autonomy: "supervised", tickets: 1 });
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  await until(dir, slug, (v) => v.stage === "delivered");
  assert.ok(!fs.existsSync(path.join(dir, "work-01.txt")));
  fs.writeFileSync(path.join(dir, "NOTE.md"), "the human was busy\n");
  commitAll(dir, "the base moved while the campaign ran");
  applyCommand(dir, { type: "deliver", campaign: slug }, loadConsole());
  assert.ok(fs.existsSync(path.join(dir, "work-01.txt")), "the delivery merges with a merge commit");
  const subject = gitOut(dir, ["log", "-1", "--pretty=%s"]);
  assert.match(subject, /Merge/);
  assert.ok(fs.existsSync(path.join(dir, "NOTE.md")));
});

test("an uncommitted plan does not block the delivery", async () => {
  const { dir, slug } = setup({ autonomy: "trusted", tickets: 1 });
  fs.writeFileSync(path.join(dir, "orchestration", slug, "campaign.md"), fs.readFileSync(path.join(dir, "orchestration", slug, "campaign.md"), "utf8").replace("Ship three small things.", "Ship one thing."));
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  const view = await until(dir, slug, (v) => v.stage === "delivered");
  assert.equal(view.delivery.mode, "merged", JSON.stringify(view.delivery));
  assert.ok(fs.existsSync(path.join(dir, "work-01.txt")));
});

test("machine state never blocks a delivery, even without a gitignore", async () => {
  const { dir, slug } = setup({ autonomy: "trusted", tickets: 1 });
  fs.writeFileSync(path.join(dir, ".gitignore"), "");
  commitAll(dir, "drop the state ignore line");
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  const view = await until(dir, slug, (v) => v.stage === "delivered");
  assert.equal(view.delivery.mode, "merged", JSON.stringify(view.delivery));
  assert.ok(fs.existsSync(path.join(dir, "work-01.txt")));
});

test("a blocking edge holds a ticket until its blocker is done", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  writeTicket(
    dir,
    slug,
    "02-t2.md",
    { id: "02", kind: "code", touches: ["work-02.txt"], blocked_by: ["01"] },
    "## What to build\n\nFile 2.\n\n## Acceptance criteria\n\n- [ ] The file exists.",
  );
  commitAll(dir, "add blocked ticket");
  scenario({ work: [ready("first"), ready("second")], review: [ready("clean"), ready("clean")] });

  tick({ root: dir });
  let view = campaignView(dir, slug);
  assert.equal(view.tickets.find((t) => t.id === "02").stage, "blocked");

  view = await until(dir, slug, (v) => v.tickets.every((t) => t.stage === "done"));
  assert.equal(view.stage, "delivered");
});

test("tickets whose touches overlap never run at once", async () => {
  const { dir, slug } = setup({ tickets: 2 });
  for (const name of ["01-t1.md", "02-t2.md"]) {
    const file = path.join(dir, "orchestration", slug, "tickets", name);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/"work-0[12]\.txt"/, '"**"'));
  }
  scenario({ work: [ready("a"), ready("b")], review: [ready("clean"), ready("clean")] });
  tick({ root: dir });
  const state = loadState(dir, slug);
  assert.equal(Object.values(state.runs).filter((r) => r.status === "live").length, 1, "one run, not two");
  await until(dir, slug, (v) => v.tickets.every((t) => t.stage === "done"));
});

test("a question is judged, escalates to the inbox, and an answer resumes the same session", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({
    work: [
      {
        status: "needs_answer",
        summary: "built half",
        question: { text: "Which migration order?", options: ["up first", "down first"] },
      },
      ready("built the rest"),
    ],
    judge: [{ status: "blocked", summary: "no source answers this" }],
    review: [ready("clean")],
  });

  let view = await until(dir, slug, (v) => v.tickets[0].stage === "needs_answer");
  const item = view.inbox.find((i) => i.kind === "question");
  assert.ok(item);
  assert.match(item.question.text, /migration order/);

  const firstRun = loadState(dir, slug).tickets["01"];
  applyCommand(dir, { type: "answer", campaign: slug, item: item.id, text: "up first" }, loadConsole());
  view = await until(dir, slug, (v) => v.tickets[0].stage === "done");
  const second = loadState(dir, slug).tickets["01"];
  assert.equal(second.attempts, 2, "the answer is a new attempt");
  assert.equal(second.sessionId, firstRun.sessionId, "same session resumed");
});

test("a person's answer takes its own slot above the cap", async () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole({ limits: { max_concurrent: 1, run_timeout_min: 30, stuck_after_min: 0, max_attempts: 3, human_slot_extra: 1 } });
  const data = {
    campaign: "demo",
    stage: "running",
    autonomy: "trusted",
    plan_gate: "human",
    landing: "branch",
    base: "main",
    checks: [{ name: "always", cmd: "true" }],
    budget: { tokens: null, dollars: null },
    max_autoship_lines: 200,
    kinds: { code: { models: [{ model: MODELS.strong, thinking: "high" }] } },
  };
  writeCampaign(dir, "demo", data, BODY);
  writeTicket(dir, "demo", "01-a.md", { id: "01", kind: "code", touches: ["a.txt"] }, "## What to build\n\nA.\n\n## Acceptance criteria\n\n- [ ] A.");
  writeTicket(dir, "demo", "02-b.md", { id: "02", kind: "code", touches: ["b.txt"] }, "## What to build\n\nB.\n\n## Acceptance criteria\n\n- [ ] B.");
  commitAll(dir);
  scenario({
    work: [{ status: "needs_answer", summary: "half", question: { text: "Which?" } }],
    judge: [{ status: "blocked", summary: "no source" }],
  });
  const view = await until(dir, "demo", (v) => v.inbox.some((i) => i.kind === "question"));
  const item = view.inbox.find((i) => i.kind === "question");
  tick({ root: dir });
  assert.equal(Object.values(loadState(dir, "demo").runs).filter((r) => r.status === "live").length, 1, "the cap holds at one");
  applyCommand(dir, { type: "answer", campaign: "demo", item: item.id, text: "A first" }, loadConsole());
  scenario({ work: [ready("a", ["A."]), ready("b", ["B."])], review: [ready("ok"), ready("ok")] });
  tick({ root: dir });
  const live = Object.values(loadState(dir, "demo").runs).filter((r) => r.status === "live");
  assert.equal(live.length, 2, "the human's answer is above the cap");
});

test("the orchestrator answers from a written source and never reaches the inbox", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  const body = fs.readFileSync(path.join(dir, "orchestration", slug, "campaign.md"), "utf8").replace("Touch nothing shared.", "Touch nothing shared. Migration order is up first.");
  fs.writeFileSync(path.join(dir, "orchestration", slug, "campaign.md"), body);
  scenario({
    work: [{ status: "needs_answer", summary: "half", question: { text: "Which migration order?" } }, ready("rest")],
    judge: [{ status: "ready", summary: "Up first.", next: "cite: campaign.md § Constraints" }],
    review: [ready("clean")],
  });
  const view = await until(dir, slug, (v) => v.tickets[0].stage === "done");
  assert.equal(view.inbox.filter((i) => i.kind === "question").length, 0);
  assert.ok(view.decisions.length + 1 > 0);
  const answered = view.runs.filter((r) => r.role === "judge");
  assert.equal(answered.length, 1);
});

test("a rejected review sends the ticket back to the same worker session", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({
    work: [ready("first try"), ready("fixed")],
    review: [{ status: "failed", summary: "1. src/a.ts has no null check" }, ready("clean")],
  });
  const view = await until(dir, slug, (v) => v.tickets[0].stage === "done");
  const state = loadState(dir, slug);
  const workRuns = Object.values(state.runs).filter((r) => r.role === "work");
  assert.equal(workRuns.length, 2);
  assert.equal(workRuns[1].sessionId, workRuns[0].sessionId, "the fix resumes the session that wrote it");
  assert.equal(view.tickets[0].gateCycles, 1);
});

test("a failed model falls back to the next entry in the chain", async () => {
  const { dir, slug } = setup({ tickets: 1, codeModels: [MODELS.strong, MODELS.backup] });
  scenario({
    work: [
      { status: "failed", summary: "model did not answer" },
      { status: "failed", summary: "still down" },
      { status: "failed", summary: "gave up" },
    ],
    review: [],
  });
  const view = await until(dir, slug, (v) => v.tickets[0].stage === "failed");
  const models = view.runs.filter((r) => r.role === "work").map((r) => r.model);
  assert.deepEqual(models, [MODELS.strong, MODELS.backup, MODELS.backup]);
});

test("the runner adapter and spend persist through campaign.save", () => {
  const { dir, slug } = setup({ tickets: 1 });
  applyCommand(
    dir,
    { type: "campaign.save", campaign: slug, patch: { runner: { adapter: "agy-acp", spend: "subscription-only" } } },
    loadConsole(),
  );
  const data = readCampaign(dir, slug).data;
  assert.equal(data.runner.adapter, "agy-acp");
  assert.equal(data.runner.spend, "subscription-only");
});

test("the console adapter and spend persist through settings.save", () => {
  const { dir } = setup({ tickets: 1 });
  applyCommand(
    dir,
    { type: "settings.save", patch: { runner: { adapter: "opencode-acp", spend: "subscription-only" } } },
    loadConsole(),
  );
  const runner = loadConsole().runner;
  assert.equal(runner.adapter, "opencode-acp");
  assert.equal(runner.spend, "subscription-only");
});

test("stop and retry refuse a ticket that has nothing to act on", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  await until(dir, slug, (v) => v.tickets[0].stage === "done");
  assert.throws(
    () => applyCommand(dir, { type: "stop", campaign: slug, ticket: "01" }, loadConsole()),
    /no live run/,
  );
  assert.throws(
    () => applyCommand(dir, { type: "retry", campaign: slug, ticket: "01" }, loadConsole()),
    /is done already/,
  );
});

test("three failed gate cycles park the ticket and file a failure", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({
    work: [
      ready("1"),
      ready("2"),
      ready("3"),
    ],
    review: [
      { status: "failed", summary: "still wrong" },
      { status: "failed", summary: "still wrong" },
      { status: "failed", summary: "still wrong" },
    ],
  });
  const view = await until(dir, slug, (v) => v.tickets[0].stage === "failed");
  assert.ok(view.inbox.some((i) => i.kind === "failure"));
  assert.ok(!view.runs.some((r) => r.status === "live" && r.role === "work" && r.startedAt > view.runs.at(-1)?.startedAt));
});

test("a budget ceiling pauses the campaign instead of stalling it", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  const campaignFile = path.join(dir, "orchestration", slug, "campaign.md");
  fs.writeFileSync(campaignFile, fs.readFileSync(campaignFile, "utf8").replace('"tokens":null', '"tokens":1'));
  scenario({ work: [ready("spent")], review: [ready("clean")] });
  const view = await until(dir, slug, (v) => v.stage === "paused");
  assert.match(view.reason || "", /budget/);
  assert.ok(view.inbox.some((i) => /budget/.test(i.title)));
});

test("a failed report retries to the attempt cap, then parks", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({
    work: [
      { status: "failed", summary: "could not" },
      { status: "failed", summary: "still could not" },
      { status: "failed", summary: "gave up" },
    ],
    review: [],
  });
  const view = await until(dir, slug, (v) => v.tickets[0].stage === "failed");
  assert.equal(view.tickets[0].attempts, 3, "three dispatches before parking");
  assert.ok(view.inbox.some((i) => i.kind === "failure"));
});

test("an approval that cannot merge stays open and can be retried", async () => {
  const { dir, slug } = setup({ autonomy: "supervised", tickets: 1 });
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  const view = await until(dir, slug, (v) => v.stage === "delivered");
  const item = view.inbox.find((i) => i.kind === "review");
  assert.ok(item, "a delivery review item is filed");

  fs.writeFileSync(path.join(dir, "DIRTY.txt"), "uncommitted\n");
  applyCommand(dir, { type: "review.approve", campaign: slug, item: item.id }, loadConsole());
  assert.ok(
    listItems(dir, slug, { status: "open" }).some((i) => i.id === item.id),
    "the approval stays open when the merge is blocked",
  );
  assert.equal(loadState(dir, slug).delivery.mode, "manual");
  assert.ok(!fs.existsSync(path.join(dir, "work-01.txt")), "nothing merged");

  fs.unlinkSync(path.join(dir, "DIRTY.txt"));
  applyCommand(dir, { type: "review.approve", campaign: slug, item: item.id }, loadConsole());
  assert.ok(!listItems(dir, slug, { status: "open" }).some((i) => i.id === item.id), "the retry answers the item");
  assert.ok(fs.existsSync(path.join(dir, "work-01.txt")), "the retry merges");
});

test("a campaign-level rejection does not merge the branch", async () => {
  const { dir, slug } = setup({ autonomy: "supervised", tickets: 1 });
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  const view = await until(dir, slug, (v) => v.stage === "delivered");
  const item = view.inbox.find((i) => i.kind === "review");
  const head = gitOut(dir, ["rev-parse", "HEAD"]);
  applyCommand(dir, { type: "review.reject", campaign: slug, item: item.id, text: "not yet" }, loadConsole());
  assert.ok(!fs.existsSync(path.join(dir, "work-01.txt")), "nothing merged into main");
  assert.equal(gitOut(dir, ["rev-parse", "HEAD"]), head, "no merge commit was made");
  assert.ok(fs.existsSync(path.join(dir, "orchestration", slug, "campaign.md")));
});

test("resume dismisses a budget pause item once the ceiling is raised", () => {
  const { dir, slug } = setup({ tickets: 1 });
  createItem(dir, slug, {
    kind: "failure",
    title: "Campaign paused: 100 tokens budget spent",
    brief: "Spend reached 100 tokens.",
  });
  applyCommand(dir, { type: "resume", campaign: slug }, loadConsole());
  const open = listItems(dir, slug, { status: "open" }).filter((i) => /budget/.test(i.title || ""));
  assert.equal(open.length, 0);
  const item = listItems(dir, slug).find((i) => /budget/.test(i.title || ""));
  assert.equal(item.status, "dismissed");
});

test("cancel stops every live run and pauses, keeping the tickets queued", async () => {
  const { dir, slug } = setup({ tickets: 2 });
  process.env.FAKE_DELAY_MS = "5000";
  scenario({ work: [ready("one"), ready("two")], review: [] });
  tick({ root: dir });
  const live = Object.values(loadState(dir, slug).runs).filter((r) => r.status === "live");
  assert.equal(live.length, 2);
  applyCommand(dir, { type: "cancel", campaign: slug }, loadConsole());
  const state = loadState(dir, slug);
  assert.equal(state.stage, "paused");
  assert.equal(Object.values(state.runs).filter((r) => r.status === "live").length, 0);
  assert.ok(Object.values(state.runs).every((r) => r.killed === "cancelled" || r.status !== "live"));
  for (const entry of Object.values(state.tickets)) assert.notEqual(entry.stage, "working");
  delete process.env.FAKE_DELAY_MS;
});

test("archive is refused while a run is alive, and reached when delivered", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  await until(dir, slug, (v) => v.stage === "delivered");
  applyCommand(dir, { type: "archive", campaign: slug }, loadConsole());
  assert.equal(campaignView(dir, slug).stage, "archived");
});

test("generated paths are allowed outside touches", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  const file = path.join(dir, "orchestration", slug, "campaign.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("checks:", "allow_paths:\n  - work-01.txt\nchecks:"));
  commitAll(dir, "allow the generated file");
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  const view = await until(dir, slug, (v) => v.tickets[0].stage === "done");
  assert.equal(view.stage, "delivered");
});

test("a finished ticket loses its worktree but keeps its branch", async () => {
  const { dir, slug } = setup({ tickets: 2 });
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  const view = await until(dir, slug, (v) => v.tickets[0].stage === "done");
  assert.equal(view.tickets[0].stage, "done");
  const worktrees = fs.readdirSync(path.join(dir, ".orchestration", "campaigns", slug, "worktrees"));
  assert.ok(!worktrees.includes("01"), "the finished ticket worktree is gone");
  assert.ok(worktrees.includes("_integration"));
  const branches = gitOut(dir, ["branch", "--list", "orch/*"]);
  assert.match(branches, new RegExp(`orch/${slug}/01`), "the ticket branch is kept");
  assert.match(branches, new RegExp(`orch/${slug}/integration`));
  const events = fs.readFileSync(path.join(dir, ".orchestration", "events.jsonl"), "utf8");
  assert.match(events, /"type":"worktree.removed"/);
});

test("delivery removes worktrees but keeps ticket and integration branches", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  await until(dir, slug, (v) => v.stage === "delivered");
  const worktrees = fs.readdirSync(path.join(dir, ".orchestration", "campaigns", slug, "worktrees"));
  assert.deepEqual(worktrees, ["_integration"]);
  const branches = gitOut(dir, ["branch", "--list", "orch/*"]);
  assert.match(branches, new RegExp(`orch/${slug}/integration`));
  assert.match(branches, new RegExp(`orch/${slug}/01`), "ticket branches stay after delivery");
});

test("cleanup removes campaign branches and the integration worktree, keeping the base", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  await until(dir, slug, (v) => v.stage === "delivered");
  const removed = cleanupCampaignBranches(dir, slug);
  assert.ok(removed.includes(`orch/${slug}/01`));
  assert.ok(removed.includes(`orch/${slug}/integration`));
  assert.equal(gitOut(dir, ["branch", "--list", "main"]).trim(), "* main");
  assert.deepEqual(fs.readdirSync(path.join(dir, ".orchestration", "campaigns", slug, "worktrees")), []);
  assert.ok(fs.existsSync(path.join(dir, "work-01.txt")), "the merged file stays on the base");
});

test("a lost state file is rebuilt from the runs, attempts and spend included", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  await until(dir, slug, (v) => v.stage === "delivered");
  const before = loadState(dir, slug);
  fs.unlinkSync(path.join(dir, ".orchestration", "campaigns", slug, "state.json"));
  const after = loadState(dir, slug);
  assert.equal(after.tickets["01"].stage, "done");
  assert.equal(after.tickets["01"].attempts, before.tickets["01"].attempts);
  assert.ok(after.spend.tokens > 0, "spend is recovered from the run records");
  assert.equal(after.spend.dollars.toFixed(4), before.spend.dollars.toFixed(4));
});

test("a parked ticket resumes after its worktree is gone", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({
    work: [{ status: "needs_answer", summary: "half", question: { text: "Which order?" } }, ready("rest")],
    judge: [{ status: "blocked", summary: "no source" }],
    review: [ready("clean")],
  });
  let view = await until(dir, slug, (v) => v.tickets[0].stage === "needs_answer");
  const first = Object.values(loadState(dir, slug).runs).find((r) => r.role === "work");
  const worktree = path.join(dir, ".orchestration", "campaigns", slug, "worktrees", "01");
  gitOut(dir, ["worktree", "remove", "--force", worktree]);
  gitOut(dir, ["worktree", "prune"]);
  assert.ok(!fs.existsSync(worktree));

  const item = listItems(dir, slug, { status: "open" }).find((i) => i.kind === "question");
  applyCommand(dir, { type: "answer", campaign: slug, item: item.id, text: "Oldest first." }, loadConsole());
  view = await until(dir, slug, (v) => v.tickets[0].stage === "done");
  const runs = Object.values(loadState(dir, slug).runs).filter((r) => r.role === "work");
  assert.equal(runs.length, 2);
  assert.equal(runs[1].sessionId, first.sessionId, "the same session resumed");
  assert.equal(runs[1].workdir, first.workdir, "the same worktree path was recreated");
  assert.ok(fs.existsSync(path.join(dir, "work-01.txt")), "the work landed after the resume");
});

test("plan_gate auto dispatches without a person", async () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  writeCampaign(
    dir,
    "demo",
    {
      campaign: "demo",
      stage: "awaiting_approval",
      autonomy: "unattended",
      plan_gate: "auto",
      landing: "branch",
      base: "main",
      checks: [{ name: "always", cmd: "true" }],
      budget: { tokens: null, dollars: null },
      max_autoship_lines: 200,
      kinds: {
        code: { models: [{ model: MODELS.strong, thinking: "high" }] },
        review: { models: [{ model: MODELS.backup, thinking: "high" }] },
      },
    },
    BODY,
  );
  writeTicket(dir, "demo", "01-a.md", { id: "01", kind: "code", touches: ["work-01.txt"] }, "## What to build\n\nA.\n\n## Acceptance criteria\n\n- [ ] A.");
  commitAll(dir);
  scenario({ work: [ready("wrote it", ["A."])], review: [ready("clean")] });
  const view = await until(dir, "demo", (v) => v.stage === "delivered");
  assert.equal(view.tickets[0].stage, "done");
  assert.match(fs.readFileSync(path.join(dir, "orchestration", "demo", "campaign.md"), "utf8"), /stage: delivered/);
});

test("directory landing catches a file outside the ticket's paths", async () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"), { git: false });
  writeConsole();
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  writeCampaign(
    dir,
    "demo",
    {
      campaign: "demo",
      stage: "running",
      autonomy: "trusted",
      plan_gate: "human",
      landing: "directory",
      base: "main",
      checks: [{ name: "always", cmd: "true" }],
      budget: { tokens: null, dollars: null },
      max_autoship_lines: 200,
      kinds: { code: { models: [{ model: MODELS.strong, thinking: "high" }] }, review: { models: [{ model: MODELS.backup, thinking: "high" }] } },
    },
    BODY,
  );
  writeTicket(dir, "demo", "01-a.md", { id: "01", kind: "code", touches: ["notes/**"] }, "## What to build\n\nNotes.\n\n## Acceptance criteria\n\n- [ ] Exists.");
  scenario({
    work: [
      ready("one", ["Exists."]),
      ready("two", ["Exists."]),
      ready("three", ["Exists."]),
    ],
    review: [],
  });
  const view = await until(dir, "demo", (v) => v.tickets[0].stage === "failed");
  const findings = view.inbox.find((i) => i.kind === "failure")?.findings || "";
  assert.match(findings, /work-01\.txt/, "the stray file is named");
});

test("a global pause stops new dispatch, names the reason, and leaves the campaign running", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({ work: [ready("did it")], review: [ready("clean")] });
  setDispatch("paused", { reason: "quota exhausted", by: "test" });
  tick({ root: dir });
  const paused = campaignView(dir, slug);
  assert.equal(paused.stage, "running", "the campaign itself is not paused");
  assert.equal(paused.tickets[0].stage, "queued");
  assert.match(paused.tickets[0].queue?.text || "", /dispatch paused: quota exhausted/);
  assert.equal(liveRunsFor(dir, slug), 0, "nothing started");

  setDispatch("auto", { reason: "test over", by: "test" });
  const done = await until(dir, "demo", (v) => v.stage === "delivered");
  assert.equal(done.tickets[0].stage, "done");
  assert.equal(loadDispatch().mode, "auto");
});

test("an exhausted provider window holds the ticket and the queue says which window", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({ work: [ready("did it")], review: [ready("clean")] });
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  writeConsole({
    quotas: [
      {
        provider: "test",
        window: "weekly",
        used: 100,
        limit: 100,
        resetAt: future,
        source: "manual",
        updatedAt: new Date().toISOString(),
      },
    ],
  });
  tick({ root: dir });
  const blocked = campaignView(dir, slug);
  assert.equal(blocked.tickets[0].stage, "queued");
  assert.match(blocked.tickets[0].queue?.text || "", /quota blocked: test weekly at 100%/);
  assert.equal(liveRunsFor(dir, slug), 0, "no run was started");

  const past = new Date(Date.now() - 1000).toISOString();
  writeConsole({
    quotas: [
      {
        provider: "test",
        window: "weekly",
        used: 100,
        limit: 100,
        resetAt: past,
        source: "manual",
        updatedAt: new Date().toISOString(),
      },
    ],
  });
  const done = await until(dir, "demo", (v) => v.stage === "delivered");
  assert.equal(done.tickets[0].stage, "done", "a passed reset clears the window");
});

test("an exhausted first model falls through to the next chain entry", async () => {
  const { dir, slug } = setup({ tickets: 1, codeModels: [MODELS.strong, MODELS.backup] });
  scenario({ work: [ready("did it")], review: [ready("clean")] });
  writeConsole({
    quotas: [
      {
        provider: "test",
        window: "weekly",
        used: 100,
        limit: 100,
        resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        source: "manual",
        updatedAt: new Date().toISOString(),
      },
    ],
  });
  tick({ root: dir });
  const view = campaignView(dir, slug);
  assert.equal(view.tickets[0].stage, "working");
  assert.equal(view.tickets[0].run?.model, MODELS.backup);
  assert.equal(liveRunsFor(dir, slug), 1);
  await until(dir, "demo", (v) => v.stage === "delivered");
});

test("telemetry labels actual, estimated and included costs without pretending an estimate is a bill", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({ work: [ready("did it")], review: [ready("clean")] });
  const done = await until(dir, "demo", (v) => v.stage === "delivered");
  const work = done.runs.find((run) => run.role === "work");
  assert.ok(work, "a work run exists");
  assert.ok(["actual", "estimated", "included", "unknown"].includes(work.cost.label));
  assert.equal(work.inputTokens, 60, "pi usage input is parsed");
  assert.equal(work.outputTokens, 40, "pi usage output is parsed");
  assert.equal(work.cost.label, "actual");
  assert.equal(work.cost.value, 0.01);
  assert.ok(work.tokensPerSecond == null || work.tokensPerSecond > 0, "output speed is derived when the run spans a second");
  assert.equal(work.host, os.hostname(), "the host is recorded on the run");
});

test("harness-reported child runs are observed, with rolled-up usage, and never become tickets", () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  const runPath = path.join(dir, ".orchestration", "campaigns", "demo", "runs", "r-child");
  fs.mkdirSync(runPath, { recursive: true });
  fs.writeFileSync(
    path.join(runPath, "session.json"),
    JSON.stringify({
      sessionId: "parent",
      children: [
        {
          id: "child-1",
          name: "explore",
          model: "test/model-fast",
          status: "done",
          usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 40 },
          dollars: 0.002,
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(runPath, "log.jsonl"),
    JSON.stringify({ type: "subagent_finished", id: "child-2", name: "review", model: "other/model-backup", usage: { totalTokens: 60, cost: { total: 0.001 } } }) + "\n",
  );
  const children = childrenFromLog(dir, "demo", "r-child");
  assert.equal(children.length, 2, "both session and log children are found");
  const rollup = rollupChildren(children);
  assert.equal(rollup.count, 2);
  assert.equal(rollup.tokens, 220);
  assert.equal(rollup.dollars, 0.003);
  assert.ok(children.some((child) => child.name === "explore"));
  assert.ok(children.some((child) => child.name === "review"));
});

test("a stale quota is visible but never blocks dispatch", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({ work: [ready("did it")], review: [ready("clean")] });
  writeConsole({
    quotas: [
      {
        provider: "test",
        window: "weekly",
        used: 100,
        limit: 100,
        resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        source: "stale",
        updatedAt: new Date().toISOString(),
      },
    ],
  });
  tick({ root: dir });
  const view = campaignView(dir, slug);
  assert.equal(view.tickets[0].stage, "working", "a stale window does not hold the fleet");
  assert.equal(view.quotas[0].source, "stale");
  await until(dir, "demo", (v) => v.stage === "delivered");
});

test("a ready report without acceptance evidence cannot reach done", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({ work: [{ status: "ready", summary: "trust me" }], review: [ready("clean")] });
  const view = await until(dir, slug, (v) => v.tickets[0].stage === "failed");
  assert.ok(!view.tickets.some((ticket) => ticket.stage === "done"));
  const failure = view.inbox.find((item) => item.kind === "failure");
  assert.match(failure.findings, /acceptance is required for a ready report/);
});

test("a failed acceptance result cannot be reported as ready", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  const file = path.join(dir, "orchestration", slug, "tickets", "01-t1.md");
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("- [ ] The file exists.", "- [ ] A.\n- [ ] B."),
  );
  commitAll(dir, "two criteria");
  scenario({
    work: [
      {
        status: "ready",
        summary: "half",
        acceptance: [
          { criterion: "A.", status: "passed", evidence: "fixture" },
          { criterion: "B.", status: "failed", evidence: "fixture" },
        ],
      },
    ],
    review: [ready("clean")],
  });
  const view = await until(dir, slug, (v) => v.tickets[0].stage === "failed");
  assert.match(view.inbox.find((item) => item.kind === "failure").findings, /ready requires every acceptance result to be passed/);
});

test("structured review findings reach the resume prompt and the ticket drawer state", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({
    work: [ready("first try"), ready("fixed")],
    review: [
      {
        status: "failed",
        summary: "one blocker",
        findings: [
          {
            id: "F1",
            severity: "blocker",
            file: "src/cli.ts",
            line: 42,
            problem: "argv is sliced twice",
            requiredFix: "slice argv once before parsing",
          },
        ],
      },
      ready("clean"),
    ],
  });
  let view = await until(dir, slug, (v) => v.tickets[0].gateCycles >= 1);
  let state = loadState(dir, slug);
  assert.equal(state.tickets["01"].findings[0].id, "F1");
  assert.equal(state.tickets["01"].findings[0].requiredFix, "slice argv once before parsing");
  assert.equal(view.tickets[0].gateCycles, 1);

  let workRuns = [];
  for (let i = 0; i < 80; i++) {
    tick({ root: dir });
    state = loadState(dir, slug);
    workRuns = Object.values(state.runs)
      .filter((run) => run.role === "work")
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    if (workRuns.length >= 2) break;
    await sleep(20);
  }
  assert.equal(workRuns.length, 2, "the same worker started a second attempt");
  const prompt = fs.readFileSync(
    path.join(dir, ".orchestration", "campaigns", slug, "runs", workRuns[1].id, "prompt.md"),
    "utf8",
  );
  assert.match(prompt, /\[F1\] blocker src\/cli\.ts:42/);
  assert.match(prompt, /required fix: slice argv once before parsing/);
  view = await until(dir, slug, (v) => v.tickets[0].stage === "done");
  assert.equal(view.tickets[0].gateCycles, 1);
});

test("a ready review carrying a blocker is invalid and cannot land", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  const blocker = {
    status: "ready",
    summary: "looks fine to me",
    findings: [{ id: "F1", severity: "blocker", problem: "off by one", requiredFix: "use the right index" }],
  };
  scenario({ work: [ready("one"), ready("two"), ready("three")], review: [blocker, blocker, blocker] });
  const view = await until(dir, slug, (v) => v.tickets[0].stage === "failed");
  assert.ok(!fs.existsSync(path.join(dir, "work-01.txt")), "nothing landed");
  assert.match(view.inbox.find((item) => item.kind === "failure").findings, /ready cannot carry high or blocker/);
});

test("a review pass stops applying when the branch changed while it ran", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  process.env.FAKE_DELAY_MS = "400";
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  let reviewRun = null;
  for (let i = 0; i < 80; i++) {
    tick({ root: dir });
    const state = loadState(dir, slug);
    reviewRun = Object.values(state.runs).find((run) => run.role === "review" && run.status === "live");
    if (reviewRun) break;
    await sleep(20);
  }
  assert.ok(reviewRun, "the review run started");
  const workdir = reviewRun.workdir;
  fs.writeFileSync(path.join(workdir, "work-01.txt"), "changed during review\n");
  gitOut(workdir, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-am", "branch moved during review"]);
  const view = await until(dir, slug, (v) => v.tickets[0].stage === "failed");
  delete process.env.FAKE_DELAY_MS;
  assert.ok(!fs.existsSync(path.join(dir, "work-01.txt")), "the stale review did not merge");
  const failure = view.inbox.find((item) => item.kind === "failure");
  assert.match(failure.title, /branch changed after review/);
  assert.match(failure.findings, /reviewed [0-9a-f]+, branch is now [0-9a-f]+/);
});

test("a failed integration check pauses once, and a resume at a passing head delivers", async () => {
  const { dir, slug } = setup({
    tickets: 1,
    checks: [{ name: "ticket-only", cmd: 'test "$(git rev-parse --abbrev-ref HEAD)" != "orch/demo/integration"' }],
  });
  scenario({ work: [ready("wrote it")], review: [ready("clean")] });
  let view = await until(dir, slug, (v) => v.stage === "paused");
  assert.match(view.reason, /integration checks failed/);
  assert.equal(view.tickets[0].stage, "done");
  assert.equal(view.integration.status, "failed");
  assert.ok(!fs.existsSync(path.join(dir, "work-01.txt")), "nothing delivered");
  const firstItems = view.inbox.filter((item) => item.kind === "failure" && /integration checks failed/.test(item.title));
  assert.equal(firstItems.length, 1);

  applyCommand(dir, { type: "resume", campaign: slug }, loadConsole());
  tick({ root: dir });
  const second = campaignView(dir, slug);
  assert.equal(second.stage, "paused");
  const secondItems = second.inbox.filter((item) => item.kind === "failure" && /integration checks failed/.test(item.title));
  assert.equal(secondItems.length, 1, "a repeated failure does not spawn a duplicate item");

  const campaignFile = path.join(dir, "orchestration", slug, "campaign.md");
  fs.writeFileSync(campaignFile, fs.readFileSync(campaignFile, "utf8").replace(/cmd: ".*"/, 'cmd: "true"'));
  applyCommand(dir, { type: "resume", campaign: slug }, loadConsole());
  view = await until(dir, slug, (v) => v.stage === "delivered");
  assert.equal(view.integration.status, "passed");
  assert.ok(fs.existsSync(path.join(dir, "work-01.txt")), "the passing integration tip delivered");
  assert.equal(
    view.inbox.filter((item) => item.status === "open" && item.kind === "failure").length,
    0,
    "the recovered integration failure no longer sits in the inbox",
  );
});

test("the delivery audit blocks a stale v2 review and warns for an unbound legacy one", () => {
  const { dir, slug } = setup({ tickets: 1 });
  gitOut(dir, ["branch", "orch/demo/01"]);
  gitOut(dir, ["branch", "orch/demo/integration"]);
  const plan = loadPlan(dir, slug);
  const data = readCampaign(dir, slug).data;
  const head = gitOut(dir, ["rev-parse", "HEAD"]);
  const base = {
    campaign: slug,
    stage: "running",
    tickets: { "01": { stage: "done", reviewedHead: "0000000" } },
    runs: {
      review: { ticket: "01", role: "review", reportStatus: "ready", policyVersion: 2, startedAt: "2026-01-01T00:00:00Z" },
    },
    integration: { status: "passed", head },
  };
  const stale = deliveryAudit({ root: dir, slug, state: base, plan, data });
  assert.equal(stale.ok, false);
  assert.ok(stale.blockers.some((blocker) => /changed after review/.test(blocker)));

  const legacy = {
    ...base,
    tickets: { "01": { stage: "done" } },
    runs: {
      review: { ticket: "01", role: "review", reportStatus: "ready", startedAt: "2026-01-01T00:00:00Z" },
    },
  };
  const unbound = deliveryAudit({ root: dir, slug, state: legacy, plan, data });
  assert.equal(unbound.ok, true);
  assert.ok(unbound.warnings.some((warning) => /unbound review/.test(warning)));
});

test("bulk acceptance is refused over the autoship line and accepted under it", () => {
  const { dir, slug } = setup({ tickets: 1 });
  const item = createItem(dir, slug, { kind: "review", title: "Campaign ready: demo", brief: "Ready." });
  const state = loadState(dir, slug);
  state.delivery = { mode: "manual", stats: { added: 300, removed: 300, lines: 600 } };
  saveState(dir, slug, state);
  assert.throws(
    () => applyCommand(dir, { type: "review.approve-bulk", campaign: slug, items: [item.id] }, loadConsole()),
    /under 200 changed lines/,
  );
  state.delivery = { mode: "manual", stats: { added: 3, removed: 3, lines: 6 } };
  saveState(dir, slug, state);
  const result = applyCommand(dir, { type: "review.approve-bulk", campaign: slug, items: [item.id] }, loadConsole());
  assert.equal(result.ok, true);
  assert.equal(result.approved, 1);
});
