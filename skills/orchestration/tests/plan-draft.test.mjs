import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, project, writeConsole, SKILL } from "./helpers.mjs";
import { createCampaign } from "../scripts/lib/create.mjs";
import {
  appliedAuditFile,
  appliedPlanFile,
  discardDraft,
  draftFile,
  draftPlan,
  previousDraftFile,
  readAppliedAudit,
  readDraft,
  planWarnings,
  refreshDraft,
  writeApplied,
} from "../scripts/lib/plan-draft.mjs";
import { importPlan, normalizePlan } from "../scripts/lib/plan-import.mjs";
import { loadTickets } from "../scripts/lib/plan.mjs";

const CLI = path.join(SKILL, "scripts", "orchestrate.mjs");

function plan(overrides = {}) {
  return {
    version: 1,
    goal: "Prove the draft",
    brief: "A small store and a CLI.",
    criteria: ["it works"],
    constraints: "No database.",
    assumptions: ["Plain files only."],
    open_questions: [],
    reading: "README.md",
    tickets: [
      {
        key: "store",
        title: "Storage slice",
        kind: "code",
        touches: ["src/store/**"],
        what: "Store entries.",
        accept: ["Entries survive"],
        sources: ["README.md"],
      },
      {
        key: "cli",
        title: "CLI slice",
        kind: "code",
        blocked_by: ["store"],
        touches: ["src/cli/**"],
        what: "Add commands.",
        accept: ["add works"],
        sources: ["README.md"],
      },
    ],
    ...overrides,
  };
}

function setup() {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  createCampaign({ root: dir, goal: "Prove the draft", slug: "demo" });
  return { box, dir };
}

function cli(dir, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
}

test("assumptions are required, and an empty list is allowed", () => {
  assert.throws(() => normalizePlan(plan({ assumptions: undefined })), /assumptions list/);
  assert.deepEqual(normalizePlan(plan({ assumptions: [] })).assumptions, []);
});

test("the plan cap and review warnings are enforced", () => {
  const many = plan({
    tickets: Array.from({ length: 21 }, (_, index) => ({
      key: `t${index}`,
      title: `Ticket ${index}`,
      kind: "code",
      touches: [`src/t${index}/**`],
      what: "Do it.",
      accept: ["Done"],
    })),
  });
  assert.throws(() => normalizePlan(many), /at most 20 tickets/);
  const thirteen = plan({
    tickets: Array.from({ length: 13 }, (_, index) => ({
      key: `t${index}`,
      title: `Ticket ${index}`,
      kind: "code",
      touches: [`src/t${index}/**`],
      what: "Do it.",
      accept: ["Done"],
    })),
  });
  const warnings = planWarnings({ plan: normalizePlan(thirteen), contextBytes: 0, maxConcurrent: 1 });
  assert.ok(warnings.some((warning) => /review threshold/.test(warning.text)));
  assert.ok(warnings.some((warning) => /above the 1-slot cap/.test(warning.text)));
  const risky = planWarnings({
    plan: normalizePlan(plan({ tickets: [{ ...plan().tickets[0], touches: ["src/auth/**"] }] })),
    contextBytes: 0,
    maxConcurrent: 4,
  });
  assert.ok(risky.some((warning) => /high-risk path/.test(warning.text)));
});

test("a draft keeps the previous revision and shows both deltas", () => {
  const { dir } = setup();
  const first = draftPlan({ root: dir, slug: "demo", plan: plan(), allowedKinds: ["code", "chores"] });
  assert.ok(fs.existsSync(draftFile(dir, "demo")));
  assert.equal(first.deltaPrevious, null);
  assert.equal(first.deltaApplied.added.length, 2);

  const second = draftPlan({
    root: dir,
    slug: "demo",
    plan: plan({
      tickets: [
        { ...plan().tickets[0], accept: ["Entries survive", "Read back"], sources: ["README.md", "src/store/**"] },
        { ...plan().tickets[1], blocked_by: ["store"] },
        {
          key: "docs",
          title: "Docs",
          kind: "chores",
          blocked_by: ["cli"],
          touches: ["README.md"],
          what: "Document it.",
          accept: ["README matches"],
          sources: ["README.md"],
        },
      ],
    }),
    allowedKinds: ["code", "chores"],
  });
  assert.ok(fs.existsSync(previousDraftFile(dir, "demo")));
  assert.equal(second.deltaPrevious.added.length, 1);
  assert.equal(second.deltaPrevious.changed.length, 1);
  assert.equal(second.deltaPrevious.changed[0].fields.includes("accept"), true);
  assert.equal(second.deltaApplied.added.length, 3);
  assert.equal(refreshDraft(dir, "demo", { allowedKinds: ["code", "chores"] }).deltaPrevious.added.length, 1);
});

test("open questions block import unless they are accepted", () => {
  const { dir } = setup();
  const withQuestion = plan({ open_questions: ["Which storage format?"] });
  assert.throws(() => importPlan({ root: dir, slug: "demo", plan: withQuestion, allowedKinds: ["code"] }), /open questions/);
  const result = importPlan({ root: dir, slug: "demo", plan: withQuestion, allowedKinds: ["code"], acceptOpen: true });
  assert.equal(result.openQuestions.length, 1);
});

test("sources reach the ticket frontmatter", () => {
  const { dir } = setup();
  importPlan({ root: dir, slug: "demo", plan: plan(), allowedKinds: ["code"] });
  const tickets = loadTickets(dir, "demo");
  assert.deepEqual(tickets[0].data.sources, ["README.md"]);
});

test("the applied plan and audit are written beside the state", () => {
  const { dir } = setup();
  draftPlan({ root: dir, slug: "demo", plan: plan(), allowedKinds: ["code"] });
  const result = importPlan({ root: dir, slug: "demo", plan: plan(), allowedKinds: ["code"] });
  writeApplied({ root: dir, slug: "demo", plan: result.plan, result });
  const applied = fs.readFileSync(appliedPlanFile(dir, "demo"), "utf8");
  assert.match(applied, /assumptions:/);
  assert.ok(fs.existsSync(appliedAuditFile(dir, "demo")));
  assert.equal(readAppliedAudit(dir, "demo").tickets.length, 2);
  assert.match(result.file, /campaign\.md$/);
});

test("discard removes the draft and keeps the applied plan", () => {
  const { dir } = setup();
  draftPlan({ root: dir, slug: "demo", plan: plan(), allowedKinds: ["code"] });
  const appliedResult = importPlan({ root: dir, slug: "demo", plan: plan(), allowedKinds: ["code"] });
  writeApplied({ root: dir, slug: "demo", plan: appliedResult.plan, result: appliedResult });
  draftPlan({ root: dir, slug: "demo", plan: plan({ goal: "Changed" }), allowedKinds: ["code"] });
  assert.equal(discardDraft(dir, "demo").length, 2);
  assert.equal(fs.existsSync(draftFile(dir, "demo")), false);
  assert.equal(fs.existsSync(appliedPlanFile(dir, "demo")), true);
});

test("a draft cannot be written while the campaign runs", () => {
  const { box, dir } = setup();
  const file = path.join(dir, "orchestration", "demo", "campaign.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("stage: draft", "stage: running"));
  const planFile = path.join(box, "plan.yml");
  fs.writeFileSync(planFile, "version: 1\ngoal: G\nbrief: B\nassumptions: []\ntickets:\n  - key: one\n    title: One\n    kind: code\n    touches: [src/**]\n    what: Do it.\n    accept: [Done]\n");
  const refused = cli(dir, ["plan", "draft", "demo", "--file", planFile]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /may change only/);
});

test("approval refuses while a draft exists", () => {
  const { box, dir } = setup();
  const planFile = path.join(box, "plan.yml");
  fs.writeFileSync(
    planFile,
    "version: 1\ngoal: G\nbrief: B\nassumptions: []\ntickets:\n  - key: one\n    title: One\n    kind: code\n    touches: [src/**]\n    what: Do it.\n    accept: [Done]\n",
  );
  assert.equal(cli(dir, ["plan", "draft", "demo", "--file", planFile]).status, 0);
  const refused = cli(dir, ["approve", "demo"]);
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /unapplied draft/);
  assert.equal(cli(dir, ["plan", "discard", "demo"]).status, 0);
});

test("the CLI refuses an open-question draft until --accept-open", () => {
  const { box, dir } = setup();
  const planFile = path.join(box, "plan.yml");
  fs.writeFileSync(
    planFile,
    `version: 1
goal: G
brief: B
assumptions: []
open_questions:
  - Which format?
tickets:
  - key: one
    title: One
    kind: code
    touches: [src/**]
    what: Do it.
    accept: [Done]
`,
  );
  assert.equal(cli(dir, ["plan", "draft", "demo", "--file", planFile]).status, 0);
  const refused = cli(dir, ["plan", "import", "demo"]);
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /open questions/);
  const accepted = cli(dir, ["plan", "import", "demo", "--accept-open"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(readAppliedAudit(dir, "demo").openQuestions.length, 1);
});

test("the CLI draft, show, diff and import loop runs from the draft file", () => {
  const { box, dir } = setup();
  const planFile = path.join(box, "plan.yml");
  fs.writeFileSync(
    planFile,
    `version: 1
goal: Prove the draft
brief: |
  A small store.
criteria:
  - it works
constraints: No database.
assumptions:
  - Plain files only.
open_questions: []
reading: README.md
tickets:
  - key: store
    title: Storage slice
    kind: code
    touches: [src/store/**]
    what: Store entries.
    accept: [Entries survive]
    sources: [README.md]
`,
  );
  const draft = cli(dir, ["plan", "draft", "demo", "--file", planFile]);
  assert.equal(draft.status, 0, draft.stderr);
  assert.match(draft.stdout, /Apply will change/);
  assert.ok(fs.existsSync(draftFile(dir, "demo")));

  const show = cli(dir, ["plan", "show", "demo", "--ticket", "store"]);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /Entries survive/);

  const diff = cli(dir, ["plan", "diff", "demo"]);
  assert.equal(diff.status, 0, diff.stderr);
  assert.match(diff.stdout, /Since your last draft/);

  const imported = cli(dir, ["plan", "import", "demo"]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.ok(fs.existsSync(path.join(dir, "orchestration", "demo", "tickets", "01-storage-slice.md")));
  assert.equal(fs.existsSync(draftFile(dir, "demo")), false);
  assert.ok(fs.existsSync(appliedAuditFile(dir, "demo")));

  const force = cli(dir, ["plan", "import", "demo", "--force"]);
  assert.notEqual(force.status, 0);
  assert.match(force.stderr, /does not accept --force/);
});
