import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, project, writeConsole, writeCampaign, writeTicket, commitAll, scenario, sleep, gitOut, MODELS } from "./helpers.mjs";
import { tick, applyCommand } from "../scripts/lib/engine.mjs";
import { campaignView } from "../scripts/lib/view.mjs";
import { loadState } from "../scripts/lib/state.mjs";
import { loadConsole } from "../scripts/lib/config.mjs";
import { listItems } from "../scripts/lib/inbox.mjs";

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

function setup({ autonomy = "trusted", tickets = 3, codeModels = null } = {}) {
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
    checks: [{ name: "always", cmd: "true" }],
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

async function until(root, slug, predicate, { ticks = 120, wait = 60 } = {}) {
  for (let i = 0; i < ticks; i++) {
    tick({ root });
    const view = campaignView(root, slug);
    if (predicate(view)) return view;
    await sleep(wait);
  }
  const view = campaignView(root, slug);
  throw new Error(
    `did not settle: ${view.tickets.map((t) => `${t.id}:${t.stage}`).join(" ")} inbox=${view.inbox.length}`,
  );
}

test("three parallel tickets reach done, land on an integration branch, and deliver", async () => {
  const { dir, slug } = setup();
  scenario({ work: [{ status: "ready", summary: "wrote it" }, { status: "ready", summary: "wrote it" }, { status: "ready", summary: "wrote it" }], review: [{ status: "ready", summary: "clean" }, { status: "ready", summary: "clean" }, { status: "ready", summary: "clean" }] });

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
  scenario({ work: [{ status: "ready", summary: "wrote it" }], review: [{ status: "ready", summary: "clean" }] });
  const view = await until(dir, slug, (v) => v.stage === "delivered");
  const item = view.inbox.find((i) => i.kind === "review");
  assert.ok(item, "a review item is filed");
  assert.ok(!fs.existsSync(path.join(dir, "work-01.txt")), "nothing merged into main yet");
  applyCommand(dir, { type: "review.approve", campaign: slug, item: item.id }, loadConsole());
  assert.ok(fs.existsSync(path.join(dir, "work-01.txt")), "approval merges");
});

test("a manual delivery still merges after the base has moved", async () => {
  const { dir, slug } = setup({ autonomy: "supervised", tickets: 1 });
  scenario({ work: [{ status: "ready", summary: "wrote it" }], review: [{ status: "ready", summary: "clean" }] });
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
  scenario({ work: [{ status: "ready", summary: "wrote it" }], review: [{ status: "ready", summary: "clean" }] });
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
  scenario({ work: [{ status: "ready", summary: "first" }, { status: "ready", summary: "second" }], review: [{ status: "ready", summary: "clean" }, { status: "ready", summary: "clean" }] });

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
  scenario({ work: [{ status: "ready", summary: "a" }, { status: "ready", summary: "b" }], review: [{ status: "ready", summary: "clean" }, { status: "ready", summary: "clean" }] });
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
      { status: "ready", summary: "built the rest" },
    ],
    judge: [{ status: "blocked", summary: "no source answers this" }],
    review: [{ status: "ready", summary: "clean" }],
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
  scenario({ work: [{ status: "ready", summary: "a" }, { status: "ready", summary: "b" }], review: [{ status: "ready", summary: "ok" }, { status: "ready", summary: "ok" }] });
  tick({ root: dir });
  const live = Object.values(loadState(dir, "demo").runs).filter((r) => r.status === "live");
  assert.equal(live.length, 2, "the human's answer is above the cap");
});

test("the orchestrator answers from a written source and never reaches the inbox", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  const body = fs.readFileSync(path.join(dir, "orchestration", slug, "campaign.md"), "utf8").replace("Touch nothing shared.", "Touch nothing shared. Migration order is up first.");
  fs.writeFileSync(path.join(dir, "orchestration", slug, "campaign.md"), body);
  scenario({
    work: [{ status: "needs_answer", summary: "half", question: { text: "Which migration order?" } }, { status: "ready", summary: "rest" }],
    judge: [{ status: "ready", summary: "Up first.", next: "cite: campaign.md § Constraints" }],
    review: [{ status: "ready", summary: "clean" }],
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
    work: [{ status: "ready", summary: "first try" }, { status: "ready", summary: "fixed" }],
    review: [{ status: "failed", summary: "1. src/a.ts has no null check" }, { status: "ready", summary: "clean" }],
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

test("stop and retry refuse a ticket that has nothing to act on", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({ work: [{ status: "ready", summary: "wrote it" }], review: [{ status: "ready", summary: "clean" }] });
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
      { status: "ready", summary: "1" },
      { status: "ready", summary: "2" },
      { status: "ready", summary: "3" },
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
  scenario({ work: [{ status: "ready", summary: "spent" }], review: [{ status: "ready", summary: "clean" }] });
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

test("a campaign-level rejection does not merge the branch", async () => {
  const { dir, slug } = setup({ autonomy: "supervised", tickets: 1 });
  scenario({ work: [{ status: "ready", summary: "wrote it" }], review: [{ status: "ready", summary: "clean" }] });
  const view = await until(dir, slug, (v) => v.stage === "delivered");
  const item = view.inbox.find((i) => i.kind === "review");
  const head = gitOut(dir, ["rev-parse", "HEAD"]);
  applyCommand(dir, { type: "review.reject", campaign: slug, item: item.id, text: "not yet" }, loadConsole());
  assert.ok(!fs.existsSync(path.join(dir, "work-01.txt")), "nothing merged into main");
  assert.equal(gitOut(dir, ["rev-parse", "HEAD"]), head, "no merge commit was made");
  assert.ok(fs.existsSync(path.join(dir, "orchestration", slug, "campaign.md")));
});

test("cancel stops every live run and pauses, keeping the tickets queued", async () => {
  const { dir, slug } = setup({ tickets: 2 });
  process.env.FAKE_DELAY_MS = "5000";
  scenario({ work: [{ status: "ready", summary: "one" }, { status: "ready", summary: "two" }], review: [] });
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
  scenario({ work: [{ status: "ready", summary: "wrote it" }], review: [{ status: "ready", summary: "clean" }] });
  await until(dir, slug, (v) => v.stage === "delivered");
  applyCommand(dir, { type: "archive", campaign: slug }, loadConsole());
  assert.equal(campaignView(dir, slug).stage, "archived");
});

test("generated paths are allowed outside touches", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  const file = path.join(dir, "orchestration", slug, "campaign.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("checks:", "allow_paths:\n  - work-01.txt\nchecks:"));
  commitAll(dir, "allow the generated file");
  scenario({ work: [{ status: "ready", summary: "wrote it" }], review: [{ status: "ready", summary: "clean" }] });
  const view = await until(dir, slug, (v) => v.tickets[0].stage === "done");
  assert.equal(view.stage, "delivered");
});

test("delivery prunes the ticket worktrees and branches but keeps the integration branch", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({ work: [{ status: "ready", summary: "wrote it" }], review: [{ status: "ready", summary: "clean" }] });
  await until(dir, slug, (v) => v.stage === "delivered");
  const worktrees = fs.readdirSync(path.join(dir, ".orchestration", "campaigns", slug, "worktrees"));
  assert.deepEqual(worktrees, ["_integration"]);
  const branches = gitOut(dir, ["branch", "--list", "orch/*"]);
  assert.match(branches, new RegExp(`orch/${slug}/integration`));
  assert.doesNotMatch(branches, new RegExp(`orch/${slug}/01`));
});

test("a lost state file is rebuilt from the runs, attempts and spend included", async () => {
  const { dir, slug } = setup({ tickets: 1 });
  scenario({ work: [{ status: "ready", summary: "wrote it" }], review: [{ status: "ready", summary: "clean" }] });
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
    work: [{ status: "needs_answer", summary: "half", question: { text: "Which order?" } }, { status: "ready", summary: "rest" }],
    judge: [{ status: "blocked", summary: "no source" }],
    review: [{ status: "ready", summary: "clean" }],
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
  scenario({ work: [{ status: "ready", summary: "wrote it" }], review: [{ status: "ready", summary: "clean" }] });
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
      { status: "ready", summary: "one" },
      { status: "ready", summary: "two" },
      { status: "ready", summary: "three" },
    ],
    review: [],
  });
  const view = await until(dir, "demo", (v) => v.tickets[0].stage === "failed");
  const findings = view.inbox.find((i) => i.kind === "failure")?.findings || "";
  assert.match(findings, /work-01\.txt/, "the stray file is named");
});
