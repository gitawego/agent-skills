import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { sandbox, project, writeConsole, MODELS, SKILL } from "./helpers.mjs";

const CLI = path.join(SKILL, "scripts", "orchestrate.mjs");

function cli(cwd, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("campaign-scoped verbs accept a positional campaign when several exist", () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  assert.equal(cli(dir, ["init"]).status, 0);
  assert.equal(cli(dir, ["start", "first campaign"]).status, 0);
  assert.equal(cli(dir, ["start", "second campaign"]).status, 0);

  const cancel = cli(dir, ["cancel", "second-campaign"]);
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, /second-campaign \[paused\]/);

  const first = cli(dir, ["status", "first-campaign"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /first-campaign \[draft\]/);
});

test("init, start, catalog, bind, plan and approve work from the CLI", () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();

  const init = cli(dir, ["init"]);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /adapters .*models/);
  assert.ok(fs.existsSync(path.join(dir, ".orchestration")));

  const start = cli(dir, ["start", "make the thing work"]);
  assert.equal(start.status, 0, start.stderr);
  const campaignFile = path.join(dir, "orchestration", "make-the-thing-work", "campaign.md");
  assert.ok(fs.existsSync(campaignFile));
  assert.match(fs.readFileSync(campaignFile, "utf8"), /## Goal/);

  const catalog = cli(dir, ["catalog", "strong"]);
  assert.equal(catalog.status, 0);
  assert.match(catalog.stdout, /test\/model-strong/);

  const badBind = cli(dir, ["bind", "make-the-thing-work", "code", "nope/nope:high"]);
  assert.equal(badBind.status, 1);
  assert.match(badBind.stderr, /not in the catalog/);

  const bind = cli(dir, ["bind", "make-the-thing-work", "code", `${MODELS.strong}:high`, "--fallback", `${MODELS.fast}:medium`]);
  assert.equal(bind.status, 0, bind.stderr);
  assert.match(fs.readFileSync(campaignFile, "utf8"), /model-strong/);

  const approveNoTickets = cli(dir, ["approve", "make-the-thing-work"]);
  assert.equal(approveNoTickets.status, 1);
  assert.match(approveNoTickets.stderr, /no tickets/);

  fs.writeFileSync(
    path.join(dir, "orchestration", "make-the-thing-work", "tickets", "01-step.md"),
    `---\nid: "01"\nkind: code\ntouches: ["src/**"]\n---\n\n## What to build\n\nOne step.\n\n## Acceptance criteria\n\n- [ ] Works.\n`,
  );

  const plan = cli(dir, ["plan"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /01/);

  const approve = cli(dir, ["approve", "make-the-thing-work"]);
  assert.equal(approve.status, 0, approve.stderr);
  assert.match(fs.readFileSync(campaignFile, "utf8"), /stage: running/);
});

test("link and desktop install launchers where the platform looks for them", () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  cli(dir, ["init"]);

  const link = cli(dir, ["link"]);
  assert.equal(link.status, 0, link.stderr);
  const launcher = path.join(process.env.XDG_BIN_HOME, "orchestrate");
  assert.ok(fs.existsSync(launcher));
  assert.match(fs.readFileSync(launcher, "utf8"), /orchestrate\.mjs" \"\$@\"/);
  assert.ok((fs.statSync(launcher).mode & 0o111) !== 0, "the launcher is executable");

  const desktop = cli(dir, ["desktop"]);
  assert.equal(desktop.status, 0, desktop.stderr);
  const entry = path.join(process.env.XDG_DATA_HOME, "applications", "orchestration.desktop");
  assert.ok(fs.existsSync(entry));
  const text = fs.readFileSync(entry, "utf8");
  assert.match(text, /^\[Desktop Entry\]/);
  assert.match(text, new RegExp(`Exec=${launcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} up`));

  const removed = cli(dir, ["desktop", "remove"]);
  assert.equal(removed.status, 0);
  assert.ok(!fs.existsSync(entry));
});

test("down says so when nothing is running", () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  const res = cli(dir, ["down"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /no panel is running/);
});

test("a binding is refused while the campaign is running", () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  cli(dir, ["init"]);
  cli(dir, ["start", "demo"]);
  const file = path.join(dir, "orchestration", "demo", "campaign.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("stage: draft", "stage: running"));
  const res = cli(dir, ["bind", "demo", "code", `${MODELS.strong}:high`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /only while nothing is running/);
});

test("ticket add writes the next ticket from the CLI", () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  cli(dir, ["init"]);
  cli(dir, ["start", "demo work"]);
  const file = path.join(dir, "orchestration", "demo-work", "campaign.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("stage: draft", "stage: running"));
  const res = cli(dir, [
    "ticket",
    "add",
    "Build the parser",
    "--campaign",
    "demo-work",
    "--kind",
    "code",
    "--touches",
    "src/parse/**",
    "--what",
    "Parse the thing.",
    "--accept",
    "it parses",
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^01 {2}Build the parser/u);
  const ticket = fs.readFileSync(path.join(dir, "orchestration", "demo-work", "tickets", "01-build-the-parser.md"), "utf8");
  assert.match(ticket, /touches/);
  assert.match(ticket, /it parses/);
});

test("ticket edit and remove work from the CLI, and a live campaign can be cancelled", () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  cli(dir, ["init"]);
  cli(dir, ["start", "demo"]);
  cli(dir, ["ticket", "add", "First thing", "--campaign", "demo", "--kind", "code", "--touches", "src/**", "--accept", "works"]);

  const edited = cli(dir, ["ticket", "edit", "01", "--campaign", "demo", "--title", "First thing, renamed", "--touches", "src/a.ts"]);
  assert.equal(edited.status, 0, edited.stderr);
  const text = fs.readFileSync(path.join(dir, "orchestration", "demo", "tickets", "01-first-thing.md"), "utf8");
  assert.match(text, /src\/a\.ts/, "the paths changed");
  assert.match(text, /# First thing, renamed/, "the heading changed; the filename stays stable");

  const removed = cli(dir, ["ticket", "remove", "01", "--campaign", "demo"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.readdirSync(path.join(dir, "orchestration", "demo", "tickets")).length, 0);

  cli(dir, ["ticket", "add", "Slow one", "--campaign", "demo", "--kind", "code", "--touches", "src/**", "--accept", "works"]);
  const scenarioFile = process.env.FAKE_SCENARIO;
  fs.writeFileSync(scenarioFile, JSON.stringify({ work: [{ status: "ready", summary: "done" }], review: [{ status: "ready", summary: "ok" }] }));
  process.env.FAKE_DELAY_MS = "4000";
  const approve = cli(dir, ["approve", "demo"]);
  assert.equal(approve.status, 0, approve.stderr);
  const cancelled = cli(dir, ["cancel", "demo"]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const status = cli(dir, ["status", "demo"]);
  assert.match(status.stdout, /paused/);
  delete process.env.FAKE_DELAY_MS;
});

test("dispatch and quota commands share the console state with the panel", () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();

  assert.equal(cli(dir, ["dispatch"]).stdout.split("\n")[0].trim(), "dispatch  auto");
  const refused = cli(dir, ["dispatch", "pause"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /requires a reason/i);

  const paused = cli(dir, ["dispatch", "pause", "--reason", "quota exhausted"]);
  assert.equal(paused.status, 0, paused.stderr);
  assert.match(paused.stdout, /paused · quota exhausted/);
  assert.match(cli(dir, ["dispatch", "status"]).stdout, /quota exhausted/);
  assert.equal(cli(dir, ["dispatch", "resume"]).status, 0);
  assert.equal(cli(dir, ["dispatch"]).stdout.split("\n")[0].trim(), "dispatch  auto");

  const set = cli(dir, [
    "quota",
    "set",
    "opencode-go",
    "--adapter",
    "opencode-acp",
    "--window",
    "5h",
    "--used",
    "72",
    "--limit",
    "100",
    "--reset",
    "2026-11-10T15:00:00Z",
  ]);
  assert.equal(set.status, 0, set.stderr);
  const list = cli(dir, ["quota", "list"]);
  assert.match(list.stdout, /opencode-go\s+5h\s+72\/100\s+manual\s+2026-11-10T15:00:00(?:\.000)?Z/);
  assert.equal(cli(dir, ["quota", "remove", "opencode-go"]).status, 0);
  assert.match(cli(dir, ["quota", "list"]).stdout, /no quotas configured/);
});
