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
  deriveAppliedAudit,
  discardDraft,
  draftFile,
  draftPlan,
  persistAppliedAudit,
  previousDraftFile,
  readAppliedAudit,
  readDraft,
  planWarnings,
  refreshDraft,
  writeApplied,
} from "../scripts/lib/plan-draft.mjs";
import { importPlan, normalizePlan } from "../scripts/lib/plan-import.mjs";
import { loadTickets } from "../scripts/lib/plan.mjs";
import { loadConsole } from "../scripts/lib/config.mjs";
import { approveCampaign } from "../scripts/lib/engine.mjs";
import { stringifyYaml } from "../scripts/lib/yaml.mjs";

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
  assert.throws(() => normalizePlan(many), /at most 16 tickets/);
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
  assert.ok(warnings.some((warning) => /one path/.test(warning.text)));
});

test("fragmentation warnings name merge candidates and long serial chains", () => {
  const shared = plan({
    tickets: [
      { ...plan().tickets[0], touches: ["src/shared/**"] },
      { ...plan().tickets[1], touches: ["src/shared/**"], blocked_by: ["store"] },
    ],
  });
  const merged = planWarnings({ plan: normalizePlan(shared), contextBytes: 0, maxConcurrent: 4 });
  assert.ok(merged.some((warning) => /merge candidate/.test(warning.text)));

  const chain = plan({
    tickets: Array.from({ length: 4 }, (_, index) => ({
      key: `c${index}`,
      title: `Chain ${index}`,
      kind: "code",
      touches: [`src/c${index}.js`],
      blocked_by: index ? [`c${index - 1}`] : [],
      what: "One link.",
      accept: ["It works", "It stays working"],
    })),
  });
  const serial = planWarnings({ plan: normalizePlan(chain), contextBytes: 0, maxConcurrent: 4 });
  assert.ok(serial.some((warning) => /one 4-ticket chain/.test(warning.text)));
});

test("four small slices are blocked unless explicitly accepted", () => {
  const { box, dir } = setup();
  const small = plan({
    tickets: Array.from({ length: 4 }, (_, index) => ({
      key: `s${index}`,
      title: `Small ${index}`,
      kind: "code",
      touches: [`src/s${index}.js`],
      what: "One small thing.",
      accept: ["It works"],
    })),
  });
  assert.throws(() => importPlan({ root: dir, slug: "demo", plan: small, allowedKinds: ["code"] }), /too fragmented/);
  const accepted = importPlan({ root: dir, slug: "demo", plan: small, allowedKinds: ["code"], acceptFragmented: true });
  assert.equal(accepted.fragmentation.blocking, true);
  assert.equal(accepted.tickets.length, 4);

  const file = path.join(box, "small.yml");
  fs.writeFileSync(file, stringifyYaml(small));
  const refused = cli(dir, ["plan", "import", "demo", "--file", file]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /too fragmented/);
  const forced = cli(dir, ["plan", "import", "demo", "--file", file, "--accept-fragmented"]);
  assert.equal(forced.status, 0, forced.stderr);
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

test("legacy campaigns derive an applied audit and can persist it", () => {
  const { box, dir } = setup();
  const applied = importPlan({ root: dir, slug: "demo", plan: plan(), allowedKinds: ["code"] });
  writeApplied({ root: dir, slug: "demo", plan: applied.plan, result: applied });
  fs.unlinkSync(appliedAuditFile(dir, "demo"));
  const derived = deriveAppliedAudit(dir, "demo", { appliedAt: "2026-01-01T00:00:00Z" });
  assert.equal(derived.derived, true);
  assert.equal(derived.tickets.length, 2);
  assert.equal(derived.appliedAt, "2026-01-01T00:00:00Z");
  fs.unlinkSync(appliedPlanFile(dir, "demo"));
  const fromTickets = deriveAppliedAudit(dir, "demo");
  assert.equal(fromTickets.derived, true);
  assert.equal(fromTickets.tickets.length, 2);
  assert.equal(fromTickets.assumptions.length, 1);
  persistAppliedAudit(dir, "demo", fromTickets);
  assert.equal(readAppliedAudit(dir, "demo").derived, true);

  const cliPlan = path.join(box, "plan.yml");
  fs.writeFileSync(
    cliPlan,
    "version: 1\ngoal: G\nbrief: B\nassumptions: []\ntickets:\n  - key: one\n    title: One\n    kind: code\n    touches: [src/**]\n    what: Do it.\n    accept: [Done]\n",
  );
  assert.equal(cli(dir, ["plan", "draft", "demo", "--file", cliPlan]).status, 0);
  assert.equal(cli(dir, ["plan", "import", "demo"]).status, 0);
  fs.unlinkSync(appliedAuditFile(dir, "demo"));
  const audit = cli(dir, ["plan", "audit", "demo", "--json"]);
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).derived, true);
  assert.equal(cli(dir, ["plan", "audit", "demo", "--write"]).status, 0);
  assert.equal(readAppliedAudit(dir, "demo").derived, true);
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

test("approval applies a clean draft, approves it once, and is idempotent", () => {
  const { box, dir } = setup();
  const planFile = path.join(box, "plan.yml");
  fs.writeFileSync(
    planFile,
    "version: 1\ngoal: G\nbrief: B\nassumptions: []\ntickets:\n  - key: one\n    title: One\n    kind: code\n    touches: [src/**]\n    what: Do it.\n    accept: [Done]\n",
  );
  assert.equal(cli(dir, ["plan", "draft", "demo", "--file", planFile]).status, 0);
  const approved = cli(dir, ["approve", "demo"]);
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.stdout, /clean draft applied/);
  assert.equal(fs.existsSync(draftFile(dir, "demo")), false, "the draft is consumed");
  assert.equal(loadTickets(dir, "demo").length, 1, "the draft became the applied plan");
  assert.equal(readAppliedAudit(dir, "demo").tickets.length, 1);
  assert.equal(JSON.parse(cli(dir, ["status", "demo", "--json"]).stdout).campaigns[0].stage, "running");

  const again = cli(dir, ["approve", "demo"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(loadTickets(dir, "demo").length, 1, "a second approve creates no duplicate ticket");
  const events = fs.readFileSync(path.join(dir, ".orchestration", "events.jsonl"), "utf8");
  assert.equal((events.match(/"type":"campaign.approved"/g) || []).length, 1, "a second approve adds no event");
});

test("approve refuses an open-question draft and leaves tickets untouched", () => {
  const { dir } = setup();
  draftPlan({
    root: dir,
    slug: "demo",
    plan: plan({ open_questions: ["Which storage format?"] }),
    allowedKinds: ["code", "review"],
  });
  assert.throws(
    () => approveCampaign(dir, "demo", loadConsole()),
    /the draft is not ready/,
  );
  assert.equal(loadTickets(dir, "demo").length, 0, "nothing was applied");
  assert.equal(readDraft(dir, "demo").exists, true, "the draft is kept for a decision");
});

test("approve refuses a draft that cannot bind, before applying any ticket", () => {
  const { dir } = setup();
  writeConsole({ unbound: true });
  draftPlan({ root: dir, slug: "demo", plan: plan(), allowedKinds: ["code", "review"] });
  assert.throws(
    () => approveCampaign(dir, "demo", loadConsole()),
    /the draft does not bind/,
  );
  assert.equal(loadTickets(dir, "demo").length, 0, "preflight failure wrote no tickets");
  assert.equal(readDraft(dir, "demo").exists, true);
});

test("approve applies a clean draft with covers and records coverage", () => {
  const { dir } = setup();
  const claimed = plan({
    tickets: [{ ...plan().tickets[0], covers: ["it works"] }],
  });
  draftPlan({ root: dir, slug: "demo", plan: claimed, allowedKinds: ["code", "review"] });
  approveCampaign(dir, "demo", loadConsole());
  const tickets = loadTickets(dir, "demo");
  assert.equal(tickets.length, 1);
  assert.deepEqual(tickets[0].data.covers, ["it works"]);
  const audit = readAppliedAudit(dir, "demo");
  assert.equal(audit.coverage.claimed, 1);
  assert.equal(audit.coverage.total, 1);
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

test("plan draft prints coverage and warns without blocking", () => {
  const { box, dir } = setup();
  const file = path.join(box, "plan.yml");
  fs.writeFileSync(file, stringifyYaml(plan()));
  const missing = cli(dir, ["plan", "draft", "demo", "--file", file]);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /coverage: 0\/1 criteria claimed; missing: it works/);
  assert.match(missing.stdout, /Coverage is a warning, not a gate/);

  fs.writeFileSync(
    file,
    stringifyYaml(plan({ tickets: [{ ...plan().tickets[0], covers: ["it works"] }] })),
  );
  const claimed = cli(dir, ["plan", "draft", "demo", "--file", file]);
  assert.equal(claimed.status, 0, claimed.stderr);
  assert.match(claimed.stdout, /coverage: 1\/1 criteria claimed/);
  assert.doesNotMatch(claimed.stdout, /Coverage is a warning/);
});

test("plan draft hides informational warnings unless --verbose", () => {
  const { box, dir } = setup();
  const file = path.join(box, "plan.yml");
  fs.writeFileSync(
    file,
    stringifyYaml(
      plan({
        tickets: [{ ...plan().tickets[0], sources: [] }],
      }),
    ),
  );
  const quiet = cli(dir, ["plan", "draft", "demo", "--file", file]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stdout, /cites no sources/);
  const verbose = cli(dir, ["plan", "draft", "demo", "--file", file, "--verbose"]);
  assert.equal(verbose.status, 0, verbose.stderr);
  assert.match(verbose.stdout, /cites no sources/);
});

test("plan draft and plan import accept stdin", () => {
  const { dir } = setup();
  const text = `version: 1
goal: Stdin plan
brief: |
  From stdin.
criteria:
  - It works
constraints: None.
assumptions: []
open_questions: []
reading: README.md
tickets:
  - key: one
    title: One
    kind: code
    touches: [src/**]
    what: Do it.
    accept: [Done]
`;
  const drafted = spawnSync(process.execPath, [CLI, "plan", "draft", "demo", "--stdin"], {
    cwd: dir,
    input: text,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(drafted.status, 0, drafted.stderr);
  assert.equal(readDraft(dir, "demo").plan.tickets[0].key, "one");

  const imported = spawnSync(process.execPath, [CLI, "plan", "import", "demo", "--stdin"], {
    cwd: dir,
    input: text,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(loadTickets(dir, "demo").length, 1);
});

test("plan import --submit runs a tick; plan_gate decides whether approval is still needed", () => {
  const { box, dir } = setup();
  const file = path.join(box, "plan.yml");
  fs.writeFileSync(file, stringifyYaml(plan()));
  assert.equal(cli(dir, ["plan", "draft", "demo", "--file", file]).status, 0);
  const human = cli(dir, ["plan", "import", "demo", "--submit"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /submitted · awaiting_approval/);
  assert.equal(JSON.parse(cli(dir, ["status", "demo", "--json"]).stdout).campaigns[0].stage, "awaiting_approval");

  const campaignFile = path.join(dir, "orchestration", "demo", "campaign.md");
  fs.writeFileSync(campaignFile, fs.readFileSync(campaignFile, "utf8").replace("plan_gate: human", "plan_gate: auto"));
  const auto = cli(dir, ["plan", "import", "demo", "--file", file, "--submit"]);
  assert.equal(auto.status, 0, auto.stderr);
  assert.match(auto.stdout, /submitted · running/);
});

test("a paused campaign can be re-planned and needs a fresh approve", () => {
  const { dir } = setup();
  const first = importPlan({ root: dir, slug: "demo", plan: plan(), allowedKinds: ["code", "review"] });
  writeApplied({ root: dir, slug: "demo", plan: first.plan, result: first });
  assert.equal(cli(dir, ["approve", "demo"]).status, 0);
  assert.equal(cli(dir, ["pause", "demo"]).status, 0);
  draftPlan({ root: dir, slug: "demo", plan: plan({ goal: "Revised while paused" }), allowedKinds: ["code", "review"] });
  const changed = importPlan({ root: dir, slug: "demo", plan: plan({ goal: "Revised while paused" }), allowedKinds: ["code", "review"] });
  writeApplied({ root: dir, slug: "demo", plan: changed.plan, result: changed });
  discardDraft(dir, "demo");
  const status = JSON.parse(cli(dir, ["status", "demo", "--json"]).stdout);
  assert.equal(status.campaigns[0].stage, "paused");
  assert.equal(cli(dir, ["approve", "demo"]).status, 0);
});

test("plan show --applied is readable JSON or literal YAML", () => {
  const { dir } = setup();
  const result = importPlan({ root: dir, slug: "demo", plan: plan({ brief: "line one\nline two" }), allowedKinds: ["code"] });
  writeApplied({ root: dir, slug: "demo", plan: result.plan, result });
  const shown = cli(dir, ["plan", "show", "demo", "--applied", "--json"]);
  assert.equal(shown.status, 0, shown.stderr);
  const body = JSON.parse(shown.stdout);
  assert.equal(body.goal, "Prove the draft");
  assert.equal(body.tickets.length, 2);
  const text = cli(dir, ["plan", "show", "demo", "--applied"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /brief: \|-$/m);
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
  assert.match(draft.stdout, /Runs: ~2 \(1 work \+ 1 review\)/);
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
