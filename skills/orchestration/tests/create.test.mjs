import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, project, writeConsole, writeCampaign, writeTicket, commitAll } from "./helpers.mjs";
import { createCampaign, addTicket, editTicket, removeTicket, nextTicketId, ensureGitignore } from "../scripts/lib/create.mjs";
import { loadPlan, parseTicket } from "../scripts/lib/plan.mjs";

const BODY = `## Goal\n\nShip it.\n\n## Brief\n\nB.\n\n## Acceptance criteria\n\n- [ ] ok\n\n## Constraints\n\nnone\n\n## What to read first\n\n- **Files:** README.md\n`;

function fixture() {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  return dir;
}

test("campaign.create writes a draft campaign with the console defaults", () => {
  const dir = fixture();
  const created = createCampaign({ root: dir, goal: "Ship the thing", autonomy: "trusted" });
  assert.equal(created.slug, "ship-the-thing");
  const text = fs.readFileSync(created.file, "utf8");
  assert.match(text, /stage: draft/);
  assert.match(text, /autonomy: trusted/);
  assert.match(text, /landing: branch/);
  assert.match(text, /base: main/);
  assert.match(text, /## Goal/);
  assert.ok(fs.existsSync(path.join(dir, "orchestration", "ship-the-thing", "tickets")));
});

test("the state directory is added to .gitignore once", () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, ".gitignore"), "");
  assert.equal(ensureGitignore(dir), true);
  assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^\.orchestration\/$/m);
  assert.equal(ensureGitignore(dir), false);
});

test("campaign.create refuses an existing name and an empty goal", () => {
  const dir = fixture();
  createCampaign({ root: dir, goal: "One", slug: "one" });
  assert.throws(() => createCampaign({ root: dir, goal: "One", slug: "one" }), /already exists/);
  assert.throws(() => createCampaign({ root: dir, goal: "  " }), /needs a goal/);
});

test("ticket.add writes the next number, and the plan validates", () => {
  const dir = fixture();
  const { slug } = createCampaign({ root: dir, goal: "Ship it", slug: "demo" });
  writeTicket(dir, slug, "01-first.md", { id: "01", kind: "code", touches: ["src/a/**"] }, "## What to build\n\nA.\n\n## Acceptance criteria\n\n- [ ] a");
  assert.equal(nextTicketId(dir, slug), "02");
  const created = addTicket({
    root: dir,
    slug,
    title: "Second slice",
    kind: "code",
    blockedBy: ["01"],
    touches: ["src/b/**", "docs/**"],
    what: "Add B.",
    criteria: ["B works", "B is tested"],
  });
  assert.equal(created.id, "02");
  const ticket = parseTicket(fs.readFileSync(created.file, "utf8"), created.file);
  assert.deepEqual(ticket.data.blocked_by, ["01"]);
  assert.deepEqual(ticket.data.touches, ["src/b/**", "docs/**"]);
  assert.deepEqual(ticket.criteria.map((c) => c.text), ["B works", "B is tested"]);
  assert.deepEqual(loadPlan(dir, slug).errors, []);
});

test("ticket.add refuses what would break the plan, and leaves nothing behind", () => {
  const dir = fixture();
  const { slug } = createCampaign({ root: dir, goal: "Ship it", slug: "demo" });
  const before = fs.readdirSync(path.join(dir, "orchestration", slug, "tickets"));
  assert.throws(() => addTicket({ root: dir, slug, title: "x", kind: "code", touches: [], criteria: ["y"] }), /which paths/);
  assert.throws(() => addTicket({ root: dir, slug, title: "x", kind: "code", touches: ["a"], criteria: [] }), /acceptance criterion/);
  assert.throws(() => addTicket({ root: dir, slug, title: "x", kind: "nope", touches: ["a"], criteria: ["y"] }), /Unknown ticket kind/);
  assert.throws(
    () => addTicket({ root: dir, slug, title: "Orphan", kind: "code", blockedBy: ["09"], touches: ["a"], criteria: ["y"] }),
    /unknown ticket/,
  );
  assert.deepEqual(fs.readdirSync(path.join(dir, "orchestration", slug, "tickets")), before);
});

test("a ticket can be edited, and an edit that breaks the plan is rolled back", () => {
  const dir = fixture();
  const { slug } = createCampaign({ root: dir, goal: "Ship it", slug: "demo" });
  const created = addTicket({ root: dir, slug, title: "First", kind: "code", touches: ["src/**"], criteria: ["works"] });
  const before = fs.readFileSync(created.file, "utf8");

  editTicket({ root: dir, slug, id: "01", patch: { title: "First, renamed", touches: ["src/a.ts"], criteria: ["still works", "is tested"] } });
  const after = parseTicket(fs.readFileSync(created.file, "utf8"), created.file);
  assert.deepEqual(after.data.touches, ["src/a.ts"]);
  assert.match(fs.readFileSync(created.file, "utf8"), /# First, renamed/);
  assert.deepEqual(after.criteria.map((c) => c.text), ["still works", "is tested"]);

  assert.throws(
    () => editTicket({ root: dir, slug, id: "01", patch: { blocked_by: ["09"] } }),
    /would break the plan/,
  );
  assert.equal(fs.readFileSync(created.file, "utf8").includes("blocked_by"), false, "the file is untouched");
  assert.throws(() => editTicket({ root: dir, slug, id: "01", patch: { kind: "nope" } }), /Unknown ticket kind/);
  assert.notEqual(before, fs.readFileSync(created.file, "utf8"));
});

test("a ticket that still blocks another cannot be removed", () => {
  const dir = fixture();
  const { slug } = createCampaign({ root: dir, goal: "Ship it", slug: "demo" });
  addTicket({ root: dir, slug, title: "First", kind: "code", touches: ["a/**"], criteria: ["a"] });
  addTicket({ root: dir, slug, title: "Second", kind: "code", touches: ["b/**"], criteria: ["b"], blockedBy: ["01"] });
  assert.throws(() => removeTicket({ root: dir, slug, id: "01" }), /still blocks 02/);
  removeTicket({ root: dir, slug, id: "02" });
  removeTicket({ root: dir, slug, id: "01" });
  assert.equal(loadPlan(dir, slug).ordered.length, 0);
  assert.deepEqual(loadPlan(dir, slug).errors.filter((e) => e.includes("no tickets")), ["the campaign has no tickets"]);
});

test("the panel's two commands create, then add", () => {
  const dir = fixture();
  const { slug } = createCampaign({ root: dir, goal: "Ship it", slug: "demo" });
  const created = addTicket({ root: dir, slug, title: "Only ticket", kind: "code", touches: ["src/**"], criteria: ["works"] });
  assert.ok(fs.existsSync(created.file));
  assert.match(path.basename(created.file), /^01-only-ticket\.md$/);
  commitAll(dir, "campaign and ticket");
  assert.equal(loadPlan(dir, slug).errors.length, 0);
});
