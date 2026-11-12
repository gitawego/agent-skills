import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, project, writeConsole, writeCampaign, writeTicket, MODELS } from "./helpers.mjs";
import { startServer } from "../scripts/lib/server.mjs";
import { enqueue } from "../scripts/lib/commands.mjs";
import { tick } from "../scripts/lib/engine.mjs";
import { globalPanelFile } from "../scripts/lib/util.mjs";

const BODY = `## Goal

Prove the panel.

## Brief

B.

## Acceptance criteria

- [ ] Shown.

## Constraints

C.

## What to read first

- **Files:** README.md
`;

function fixture() {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole();
  writeCampaign(
    dir,
    "demo",
    {
      campaign: "demo",
      stage: "awaiting_approval",
      autonomy: "supervised",
      plan_gate: "human",
      landing: "branch",
      base: "main",
      checks: [],
      budget: { tokens: null, dollars: null },
      max_autoship_lines: 200,
      kinds: { code: { models: [{ model: MODELS.strong, thinking: "high" }] } },
    },
    BODY,
  );
  writeTicket(
    dir,
    "demo",
    "01-work.md",
    { id: "01", kind: "code", touches: ["src/**"] },
    "## What to build\n\nIt.\n\n## Acceptance criteria\n\n- [ ] Works.",
  );
  return dir;
}

test("the panel serves state, refuses a missing token, and queues commands", async () => {
  const root = fixture();
  const panel = await startServer({ roots: [root], port: 0 });

  const html = await fetch(`${panel.url.replace(/\?.*/, "")}?token=${panel.token}`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /orchestration/);

  const denied = await fetch(`${panel.url.replace(/\?.*/, "")}api/state`);
  assert.equal(denied.status, 401);

  const res = await fetch(`http://127.0.0.1:${panel.port}/api/state?token=${panel.token}`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.projects.length, 1);
  assert.equal(body.projects[0].campaigns[0].slug, "demo");
  assert.equal(body.projects[0].campaigns[0].tickets[0].stage, "queued");
  assert.ok(body.console.kinds.code);
  assert.ok(Array.isArray(body.catalog) && body.catalog.length > 0, "the catalog is offered");
  assert.ok(body.catalog[0].provider && body.catalog[0].model);
  assert.ok(Array.isArray(body.adapters) && body.adapters.some((a) => a.id === "pi"), "adapters are offered");
  assert.ok(body.catalogs && body.catalogs[body.projects[0].root], "a per-project catalog is offered");
  assert.ok(body.catalog.every((row) => row.adapter), "every catalog row names its adapter");

  const post = await fetch(`http://127.0.0.1:${panel.port}/api/commands?token=${panel.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root, type: "pause", campaign: "demo" }),
  });
  assert.equal(post.status, 200);

  const bad = await fetch(`http://127.0.0.1:${panel.port}/api/commands?token=${panel.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: "/nope", type: "pause" }),
  });
  assert.equal(bad.status, 400);

  panel.close();
});

test("the log endpoint refuses traversal in campaign and run names", async () => {
  const root = fixture();
  const panel = await startServer({ roots: [root], port: 0 });
  const base = `http://127.0.0.1:${panel.port}/api/log?project=${encodeURIComponent(root)}&token=${panel.token}`;

  for (const query of [
    "&campaign=../../etc&run=passwd",
    "&campaign=demo&run=../../state",
    "&campaign=demo&run=..%2f..%2fstate",
    "&campaign=demo&run=..",
  ]) {
    const res = await fetch(`${base}${query}`);
    assert.equal(res.status, 400, query);
  }

  const ok = await fetch(`${base}&campaign=demo&run=r-valid`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).text, "");
  panel.close();
});

test("an ephemeral test server does not overwrite the live panel record", async () => {
  const root = fixture();
  const file = globalPanelFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sentinel = { url: "http://127.0.0.1:9/?token=abcdef12", pid: 1 };
  fs.writeFileSync(file, JSON.stringify(sentinel));
  const panel = await startServer({ roots: [root], port: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), sentinel);
  panel.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), sentinel);
});

test("the panel queues the manual new-ticket form and the supervisor writes it", async () => {
  const root = fixture();
  const panel = await startServer({ roots: [root], port: 0, onCommand: () => tick({ root }) });
  const res = await fetch(`http://127.0.0.1:${panel.port}/api/commands?token=${panel.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      root,
      type: "ticket.add",
      campaign: "demo",
      title: "Second slice",
      kind: "code",
      touches: ["src/second/**"],
      what: "Build the second slice.",
      criteria: ["It works"],
    }),
  });
  assert.equal(res.status, 200);
  const files = fs.readdirSync(path.join(root, "orchestration", "demo", "tickets")).sort();
  assert.ok(files.some((file) => /^02-/.test(file)), `expected the next ticket, got ${files.join(", ")}`);
  panel.close();
});

test("the panel accepts an image upload and keeps it inside the campaign", async () => {
  const root = fixture();
  const panel = await startServer({ roots: [root], port: 0 });
  const data = Buffer.from("not-a-real-png").toString("base64");
  const res = await fetch(`http://127.0.0.1:${panel.port}/api/attachments?token=${panel.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root, campaign: "demo", name: "ref.png", data }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.path, "orchestration/demo/attachments/ref.png");
  assert.ok(fs.existsSync(path.join(root, body.path)));

  const pdf = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");
  const pdfRes = await fetch(`http://127.0.0.1:${panel.port}/api/attachments?token=${panel.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root, campaign: "demo", name: "spec.pdf", data: pdf }),
  });
  assert.equal(pdfRes.status, 200);
  const pdfBody = await pdfRes.json();
  assert.equal(pdfBody.mimeType, "application/pdf");
  panel.close();
});

test("the panel can open another repository", async () => {
  const root = fixture();
  const box = path.dirname(root);
  const other = project(path.join(box, "other-repo"));
  const panel = await startServer({ roots: [root], port: 0 });
  const post = await fetch(`http://127.0.0.1:${panel.port}/api/projects?token=${panel.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: other }),
  });
  assert.equal(post.status, 200);
  const state = await (await fetch(`http://127.0.0.1:${panel.port}/api/state?token=${panel.token}`)).json();
  assert.ok(state.projects.some((project) => project.root === other), "the new repository is served");
  panel.close();
});

test("the page leaves a cookie, so a refresh or a new tab needs no token", async () => {
  const root = fixture();
  const panel = await startServer({ roots: [root], port: 0 });
  const base = `http://127.0.0.1:${panel.port}`;

  const page = await fetch(`${base}/?token=${panel.token}`);
  assert.equal(page.status, 200);
  const cookie = String(page.headers.get("set-cookie") || "");
  assert.match(cookie, /orch_token=/);
  assert.match(cookie, /HttpOnly/);
  const value = cookie.split(";")[0];

  const state = await fetch(`${base}/api/state`, { headers: { cookie: value } });
  assert.equal(state.status, 200);
  const body = await state.json();
  assert.equal(body.projects[0].campaigns[0].slug, "demo");

  const bare = await fetch(`${base}/api/state`);
  assert.equal(bare.status, 401);

  panel.close();
});

test("commands can be enqueued without a server, which is what the CLI does", () => {
  const root = fixture();
  enqueue(root, { type: "pause", campaign: "demo" });
  assert.ok(true);
});
