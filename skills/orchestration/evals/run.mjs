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
  fs.writeFileSync(process.env.FAKE_SCENARIO, JSON.stringify({ work: [{ status: "ready", summary: "wrote it" }], review: [{ status: "ready", summary: "clean" }] }));
  cli(dir, ["tick"]);
  for (let i = 0; i < 40; i++) cli(dir, ["tick"]);
  const status = cli(dir, ["status", "demo"]).out;
  assert(/delivered/.test(status), `campaign did not deliver: ${status.slice(0, 200)}`);
  const inbox = cli(dir, ["inbox"]).out;
  assert(/Campaign ready/.test(inbox), "a review item was filed");
  assert(!fs.existsSync(path.join(dir, "work-01.txt")), "main is untouched until approval");
});

for (const result of results) {
  if (result.skipped) console.log(`SKIP  ${result.name} (no running panel in this environment)`);
  else console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok ? "" : `\n      ${result.error}`}`);
}
const failed = results.filter((r) => r.ok === false).length;
const ran = results.filter((r) => !r.skipped).length;
console.log(`\n${ran - failed}/${ran} executable expectations passed, ${results.length - ran} skipped`);
process.exit(failed ? 1 : 0);
