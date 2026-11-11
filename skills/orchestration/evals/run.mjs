#!/usr/bin/env node
// Executes the eval expectations that are machine-checkable. The rest depend on
// a live model driving the skill, and are listed in RESULTS.md as not executed.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandbox, project, writeConsole, writeCampaign, writeTicket, commitAll, MODELS } from "../tests/helpers.mjs";

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(SKILL, "scripts", "orchestrate.mjs");

const results = [];
function check(name, fn) {
  try {
    const outcome = fn();
    if (outcome === "skip") results.push({ name, skipped: true });
    else results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function cli(dir, args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  return { ...res, out: `${res.stdout || ""}${res.stderr || ""}` };
}
const BODY = `## Goal\n\nShip it.\n\n## Brief\n\nB.\n\n## Acceptance criteria\n\n- [ ] ok\n\n## Constraints\n\nnone\n\n## What to read first\n\n- **Files:** README.md\n`;

function fresh() {
  const box = sandbox();
  return project(path.join(box, "repo"));
}

/* eval 1: a campaign cannot be approved while a kind is unbound */
check("eval 1 — approval refuses an unbound kind and names the bind command", () => {
  const dir = fresh();
  writeConsole({ unbound: true });
  cli(dir, ["init"]);
  cli(dir, ["start", "demo", "--campaign", "demo"]);
  writeTicket(dir, "demo", "01-a.md", { id: "01", kind: "code", touches: ["src/**"] }, "## What to build\n\nA.\n\n## Acceptance criteria\n\n- [ ] A.");
  const res = cli(dir, ["approve", "demo"]);
  assert(res.status !== 0, "approval should fail");
  assert(/no model chain/.test(res.out), `expected a bind hint, got: ${res.out.slice(0, 160)}`);
  assert(/orchestrate bind/.test(res.out), "the refusal names the command");
});

/* eval 2: a model outside the catalog is refused, with the catalog offered */
check("eval 2 — an unknown model is refused and the catalog is offered", () => {
  const dir = fresh();
  writeConsole();
  cli(dir, ["init"]);
  cli(dir, ["start", "demo", "--campaign", "demo"]);
  const res = cli(dir, ["bind", "demo", "code", "nope/nope:high"]);
  assert(res.status !== 0, "the bind should fail");
  assert(/not in the catalog/.test(res.out), "the refusal says why");
  assert(/orchestrate catalog/.test(res.out), "it offers the catalog");
  const catalog = cli(dir, ["catalog"]);
  assert(catalog.status === 0 && /test\/model-strong/.test(catalog.out), "the catalog lists real ids");
});

/* eval 3: a binding cannot change under a running campaign */
check("eval 3 — a bind is refused while the campaign is running", () => {
  const dir = fresh();
  writeConsole();
  cli(dir, ["init"]);
  cli(dir, ["start", "demo", "--campaign", "demo"]);
  const file = path.join(dir, "orchestration", "demo", "campaign.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("stage: draft", "stage: running"));
  const res = cli(dir, ["bind", "demo", "code", `${MODELS.strong}:high`]);
  assert(res.status !== 0, "the bind should fail");
  assert(/only while nothing is running/.test(res.out), "it explains the rule");
  assert(/orchestrate pause/.test(res.out), "it names the way out");
});

/* eval 4: the panel URL is loopback, carries the token, and up reuses it */
const realPanel = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".local", "state", "orchestration", "panel.json"), "utf8"));
  } catch {
    return null;
  }
})();

check("eval 4 — the running panel prints a loopback URL with a token", () => {
  if (!realPanel?.url) return "skip";
  assert(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{8,}$/.test(realPanel.url), `unexpected url ${realPanel.url}`);
});

/* eval 6: supervised delivery files a review item and leaves main untouched */
check("eval 6 — a supervised campaign waits for a person and does not merge", () => {
  const dir = fresh();
  writeConsole();
  writeCampaign(
    dir,
    "demo",
    {
      campaign: "demo",
      stage: "running",
      autonomy: "supervised",
      plan_gate: "human",
      landing: "branch",
      base: "main",
      checks: [{ name: "ok", cmd: "true" }],
      budget: { tokens: null, dollars: null },
      max_autoship_lines: 200,
      kinds: { code: { models: [{ model: MODELS.strong, thinking: "high" }] }, review: { models: [{ model: MODELS.backup, thinking: "high" }] } },
    },
    BODY,
  );
  writeTicket(dir, "demo", "01-a.md", { id: "01", kind: "code", touches: ["work-01.txt"] }, "## What to build\n\nA.\n\n## Acceptance criteria\n\n- [ ] A.");
  commitAll(dir);
  const acceptance = [{ criterion: "A.", status: "passed", evidence: "fixture ran the check" }];
  fs.writeFileSync(
    process.env.FAKE_SCENARIO,
    JSON.stringify({ work: [{ status: "ready", summary: "wrote it", acceptance }], review: [{ status: "ready", summary: "clean" }] }),
  );
  cli(dir, ["tick"]);
  for (let i = 0; i < 40; i++) cli(dir, ["tick"]);
  const status = cli(dir, ["status", "demo"]).out;
  assert(/delivered/.test(status), `campaign did not deliver: ${status.slice(0, 200)}`);
  const inbox = cli(dir, ["acceptance"]).out;
  assert(/Campaign ready/.test(inbox), "a review item was filed");
  assert(!fs.existsSync(path.join(dir, "work-01.txt")), "main is untouched until approval");
});

/* eval 7: free-form context becomes a reviewed draft, then one import */
check("eval 7 — free-form context becomes a reviewed draft and one import", () => {
  const dir = fresh();
  writeConsole({ unbound: true });
  cli(dir, ["init"]);
  cli(dir, ["start", "Notes CLI", "--campaign", "notes"]);
  const box = path.dirname(dir);
  const note = path.join(box, "context.md");
  fs.writeFileSync(note, "Plain files only. No database. Tests first.\n");
  const context = cli(dir, ["context", "append", "notes", "--from", note]);
  assert(context.status === 0, context.out);
  assert(fs.existsSync(path.join(dir, "orchestration", "notes", "context.md")), "context.md was written");

  const plan = path.join(box, "plan.yml");
  fs.writeFileSync(
    plan,
    `version: 1
goal: Notes CLI
brief: |
  A zero-dependency notes CLI.
criteria:
  - notes can be added
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
    what: Append and read entries.
    accept: [A note survives a restart]
    sources: [README.md]
  - key: cli
    title: CLI slice
    kind: code
    blocked_by: [store]
    touches: [src/cli/**]
    what: Add and list commands.
    accept: [add prints added]
    sources: [README.md]
`,
  );
  const draft = cli(dir, ["plan", "draft", "notes", "--file", plan, "--json"]);
  assert(draft.status === 0, draft.out);
  const drafted = JSON.parse(draft.out);
  assert(drafted.hash && drafted.plan.tickets.length === 2, "the draft has a hash and both tickets");
  assert(drafted.coverage.total === 1 && drafted.coverage.claimed === 0, "the draft reports coverage");
  assert(/coverage: 0\/1 criteria claimed; missing: notes can be added/.test(drafted.coverageText), "missing coverage is named");
  assert(fs.existsSync(path.join(dir, ".orchestration", "campaigns", "notes", "plan.yml")), "plan.yml was written");
  assert(!fs.existsSync(path.join(dir, "orchestration", "notes", "tickets", "01-storage-slice.md")), "tickets are untouched before apply");

  fs.appendFileSync(
    plan,
    `  - key: docs
    title: Docs
    kind: chores
    blocked_by: [cli]
    touches: [README.md]
    what: Document the commands.
    accept: [README matches]
    sources: [README.md]
`,
  );
  const revised = cli(dir, ["plan", "draft", "notes", "--file", plan, "--json"]);
  assert(revised.status === 0, revised.out);
  const second = JSON.parse(revised.out);
  assert(second.deltaPrevious.added.length === 1 && second.deltaPrevious.added[0].key === "docs", "the revision delta names only the new ticket");

  const imported = cli(dir, ["plan", "import", "notes", "--json"]);
  assert(imported.status === 0, imported.out);
  const body = JSON.parse(imported.out);
  assert(body.tickets.length === 3, "all three tickets imported");
  assert(body.tickets[1].blocked_by[0] === body.tickets[0].id, "blocked_by resolves by key");
  assert(fs.existsSync(path.join(dir, ".orchestration", "campaigns", "notes", "plan.applied.json")), "the applied audit was written");
  assert(!fs.existsSync(path.join(dir, ".orchestration", "campaigns", "notes", "plan.yml")), "the draft was cleared after apply");
});

/* eval 8/9: a one-ticket plan and a four-ticket plan both report coverage */
check("eval 8 — one ticket and four tickets report their count and coverage", () => {
  const dir = fresh();
  writeConsole();
  cli(dir, ["init"]);
  cli(dir, ["start", "Coverage", "--campaign", "coverage"]);
  const box = path.dirname(dir);
  const one = path.join(box, "one.yml");
  fs.writeFileSync(
    one,
    `version: 1
goal: One outcome
brief: B
criteria: [the outcome holds]
assumptions: []
tickets:
  - key: only
    title: Only
    kind: code
    touches: [src/only/**]
    what: Do it.
    accept: [It holds]
    covers: [the outcome holds]
`,
  );
  const oneDraft = cli(dir, ["plan", "draft", "coverage", "--file", one, "--json"]);
  assert(oneDraft.status === 0, oneDraft.out);
  const oneBody = JSON.parse(oneDraft.out);
  assert(oneBody.plan.tickets.length === 1, "one ticket stays one ticket");
  assert(oneBody.coverage.claimed === 1 && oneBody.coverage.total === 1, "the one ticket covers the criterion");

  const four = path.join(box, "four.yml");
  fs.writeFileSync(
    four,
    `version: 1
goal: Four outcomes
brief: B
criteria: [the shared outcome holds]
assumptions: []
tickets:
${["a", "b", "c", "d"]
  .map(
    (key) => `  - key: ${key}
    title: ${key.toUpperCase()}
    kind: code
    touches: [src/${key}/**]
    what: Do ${key}.
    accept: [${key} holds, ${key} stays]
`,
  )
  .join("")}`,
  );
  const fourDraft = cli(dir, ["plan", "draft", "coverage", "--file", four, "--json"]);
  assert(fourDraft.status === 0, fourDraft.out);
  const fourBody = JSON.parse(fourDraft.out);
  assert(fourBody.plan.tickets.length === 4, "four tickets stay four tickets");
  assert(fourBody.coverage.claimed === 0 && fourBody.coverage.total === 1, "missing coverage is visible");
  assert(/missing: the shared outcome holds/.test(fourBody.coverageText), "the missing criterion is named");
});

/* eval 10: a ready report without acceptance evidence cannot reach done */
check("eval 10 — a ready report without acceptance evidence fails the ticket", () => {
  const dir = fresh();
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
      checks: [{ name: "ok", cmd: "true" }],
      budget: { tokens: null, dollars: null },
      max_autoship_lines: 200,
      kinds: { code: { models: [{ model: MODELS.strong, thinking: "high" }] }, review: { models: [{ model: MODELS.backup, thinking: "high" }] } },
    },
    BODY,
  );
  writeTicket(dir, "demo", "01-a.md", { id: "01", kind: "code", touches: ["work-01.txt"] }, "## What to build\n\nA.\n\n## Acceptance criteria\n\n- [ ] A.");
  commitAll(dir);
  fs.writeFileSync(process.env.FAKE_SCENARIO, JSON.stringify({ work: [{ status: "ready", summary: "trust me" }], review: [{ status: "ready", summary: "clean" }] }));
  cli(dir, ["tick"]);
  for (let i = 0; i < 20; i++) cli(dir, ["tick"]);
  const status = cli(dir, ["status", "demo"]).out;
  assert(/failed/.test(status), `the ticket did not fail: ${status.slice(0, 200)}`);
  const inbox = cli(dir, ["inbox"]).out;
  assert(/acceptance is required for a ready report/.test(inbox), "the validation error is attached");
  assert(!fs.existsSync(path.join(dir, "work-01.txt")), "nothing landed");
});

for (const result of results) {
  if (result.skipped) console.log(`SKIP  ${result.name} (no running panel in this environment)`);
  else console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok ? "" : `\n      ${result.error}`}`);
}
const failed = results.filter((r) => r.ok === false).length;
const ran = results.filter((r) => !r.skipped).length;
console.log(`\n${ran - failed}/${ran} executable expectations passed, ${results.length - ran} skipped`);
process.exit(failed ? 1 : 0);
