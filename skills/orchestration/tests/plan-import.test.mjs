import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, project, writeConsole, SKILL } from "./helpers.mjs";
import { appendContext, importPlan, readContext } from "../scripts/lib/plan-import.mjs";
import { createCampaign } from "../scripts/lib/create.mjs";
import { loadTickets } from "../scripts/lib/plan.mjs";

const CLI = path.join(SKILL, "scripts", "orchestrate.mjs");

function setup() {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  createCampaign({ root: dir, goal: "Prove the plan import", slug: "demo" });
  return { box, dir };
}

const PLAN = {
  version: 1,
  goal: "Prove the plan import",
  brief: "A small store and a CLI.",
  criteria: ["notes can be added", "notes can be listed"],
  constraints: "No database.",
  reading: "README.md",
  tickets: [
    {
      key: "storage",
      title: "Storage slice",
      kind: "code",
      touches: ["src/store/**"],
      what: "Append and read entries.",
      accept: ["A note survives a restart"],
    },
    {
      key: "cli",
      title: "CLI slice",
      kind: "code",
      blocked_by: ["storage"],
      touches: ["src/cli/**"],
      what: "Add and list commands.",
      accept: ["add prints added"],
    },
  ],
};

test("context appends timestamped blocks", () => {
  const { dir } = setup();
  appendContext({ root: dir, slug: "demo", text: "Do not add a database.", source: "human" });
  appendContext({ root: dir, slug: "demo", text: "Use plain files.", source: "human" });
  const context = readContext(dir, "demo");
  assert.equal(context.bytes > 0, true);
  assert.match(context.text, /Do not add a database\./);
  assert.match(context.text, /Use plain files\./);
  assert.equal((context.text.match(/^## /gm) || []).length, 2);
});

test("a plan writes the body and a blocked graph atomically", () => {
  const { dir } = setup();
  const result = importPlan({ root: dir, slug: "demo", plan: PLAN, allowedKinds: ["code", "review"] });
  assert.equal(result.tickets.length, 2);
  assert.equal(result.tickets[1].blocked_by[0], "01");
  const tickets = loadTickets(dir, "demo");
  assert.deepEqual(tickets.map((t) => t.data.key), ["storage", "cli"]);
  assert.deepEqual(tickets[1].data.blocked_by, ["01"]);
  const campaign = fs.readFileSync(path.join(dir, "orchestration", "demo", "campaign.md"), "utf8");
  assert.match(campaign, /## Brief\n\nA small store and a CLI\./);
  assert.match(campaign, /- \[ \] notes can be added/);
});

test("re-import keeps ids and only rewrites changed tickets", () => {
  const { dir } = setup();
  importPlan({ root: dir, slug: "demo", plan: PLAN, allowedKinds: ["code"] });
  const second = importPlan({
    root: dir,
    slug: "demo",
    plan: { ...PLAN, tickets: [{ ...PLAN.tickets[0], title: "Storage layer" }, PLAN.tickets[1]] },
    allowedKinds: ["code"],
  });
  assert.equal(second.created.length, 0);
  assert.deepEqual(second.updated.map((t) => t.id), ["01"]);
  assert.deepEqual(second.tickets.map((t) => t.id), ["01", "02"]);
});

test("an invalid plan writes nothing and leaves the previous plan intact", () => {
  const { dir } = setup();
  importPlan({ root: dir, slug: "demo", plan: PLAN, allowedKinds: ["code"] });
  const before = fs.readFileSync(path.join(dir, "orchestration", "demo", "campaign.md"), "utf8");
  assert.throws(
    () =>
      importPlan({
        root: dir,
        slug: "demo",
        plan: { ...PLAN, tickets: [{ ...PLAN.tickets[0], blocked_by: ["cli"] }, PLAN.tickets[1]] },
        allowedKinds: ["code"],
      }),
    /not saved/,
  );
  assert.equal(fs.readFileSync(path.join(dir, "orchestration", "demo", "campaign.md"), "utf8"), before);
  assert.equal(loadTickets(dir, "demo").length, 2);
});

test("prune removes a keyed ticket only when the caller allows it", () => {
  const { dir } = setup();
  importPlan({ root: dir, slug: "demo", plan: PLAN, allowedKinds: ["code"] });
  const one = { ...PLAN, tickets: [PLAN.tickets[0]] };
  assert.throws(
    () => importPlan({ root: dir, slug: "demo", plan: one, allowedKinds: ["code"], prune: true, canRemove: () => false }),
    /has runs/,
  );
  assert.equal(loadTickets(dir, "demo").length, 2);
  const result = importPlan({ root: dir, slug: "demo", plan: one, allowedKinds: ["code"], prune: true, canRemove: () => true });
  assert.deepEqual(result.removed.map((t) => t.key), ["cli"]);
  assert.equal(loadTickets(dir, "demo").length, 1);
});

test("plan import refuses a running campaign without --force", () => {
  const { box, dir } = setup();
  const file = path.join(dir, "orchestration", "demo", "campaign.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("stage: draft", "stage: running"));
  const planFile = path.join(box, "plan.yml");
  fs.writeFileSync(
    planFile,
    "version: 1\ngoal: G\nbrief: B\ntickets:\n  - key: one\n    title: One\n    kind: code\n    touches: [src/**]\n    what: Do it.\n    accept: [Done]\n",
  );
  const refused = spawnSync(process.execPath, [CLI, "plan", "import", "demo", "--file", planFile], {
    cwd: dir,
    encoding: "utf8",
    env: process.env,
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /running/);
});

test("the CLI imports a YAML plan and appends context", () => {
  const { box, dir } = setup();
  const contextFile = path.join(box, "notes.md");
  fs.writeFileSync(contextFile, "Keep it zero-dependency.\n");
  const context = spawnSync(process.execPath, [CLI, "context", "append", "demo", "--from", contextFile], {
    cwd: dir,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(context.status, 0, context.stderr);
  assert.match(readContext(dir, "demo").text, /zero-dependency/);

  const planFile = path.join(box, "plan.yml");
  fs.writeFileSync(
    planFile,
    `version: 1
goal: Prove the plan import
brief: |
  A small store and a CLI.
criteria:
  - notes can be added
constraints: No database.
reading: README.md
tickets:
  - key: storage
    title: Storage slice
    kind: code
    touches: [src/store/**]
    what: Append and read entries.
    accept: [A note survives a restart]
`,
  );
  const imported = spawnSync(process.execPath, [CLI, "plan", "import", "demo", "--file", planFile, "--json"], {
    cwd: dir,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(imported.status, 0, imported.stderr);
  const body = JSON.parse(imported.stdout);
  assert.equal(body.tickets[0].key, "storage");
  assert.equal(loadTickets(dir, "demo").length, 1);
});
