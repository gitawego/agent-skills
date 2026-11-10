import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { sandbox, project, writeConsole, writeCampaign, writeTicket } from "./helpers.mjs";
import { loadPlan } from "../scripts/lib/plan.mjs";
import { validateCampaign, runnerConfig, readCampaign } from "../scripts/lib/config.mjs";
import { allModels, adaptersView, rowsFor, writeCatalogCache } from "../scripts/lib/catalogs.mjs";

const BODY = `## Goal

Prove the adapter catalog.

## Brief

B.

## Acceptance criteria

- [ ] Shown.

## Constraints

C.

## What to read first

- **Files:** README.md
`;

function acpRows() {
  return [
    {
      adapter: "agy-acp",
      provider: "antigravity",
      model: "gemini-4-argon",
      label: "Gemini 4 Argon",
      context: null,
      maxOut: null,
      thinking: true,
      thinkingLevels: ["low", "medium", "high"],
      images: null,
      price: null,
      billing: "subscription",
      included: true,
    },
    {
      adapter: "agy-acp",
      provider: "antigravity",
      model: "gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      context: null,
      maxOut: null,
      thinking: true,
      thinkingLevels: ["low", "medium", "high"],
      images: null,
      price: null,
      billing: "subscription",
      included: true,
    },
  ];
}

function fixture() {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  const config = writeConsole();
  writeCatalogCache("agy-acp", acpRows());
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
      runner: { adapter: "agy-acp", spend: "subscription-only" },
      kinds: {
        code: { models: [{ model: "antigravity/gemini-3.8-flash", thinking: "low" }] },
        review: { models: [{ model: "antigravity/gemini-4-argon", thinking: "medium" }] },
      },
    },
    BODY,
  );
  writeTicket(
    dir,
    "demo",
    "01-work.md",
    { id: "01", kind: "code", touches: ["work.txt"] },
    "## What to build\n\nIt.\n\n## Acceptance criteria\n\n- [ ] Works.",
  );
  return { dir, config, plan: loadPlan(dir, "demo") };
}

test("an ACP campaign validates against its own cached catalog", () => {
  const { dir, config, plan } = fixture();
  const { errors, runner, rows } = validateCampaign({
    root: dir,
    consoleConfig: config,
    data: readCampaign(dir, "demo").data,
    tickets: plan.ordered,
    catalogRows: rowsFor("agy-acp"),
  });
  assert.deepEqual(errors, []);
  assert.equal(runner.adapter, "agy-acp");
  assert.equal(rows.length, 2);
});

test("subscription-only refuses a model that is not included", () => {
  const { dir, config, plan } = fixture();
  const data = {
    ...readCampaign(dir, "demo").data,
    runner: { adapter: "agy-acp", spend: "subscription-only" },
    kinds: { code: { models: [{ model: "antigravity/gemini-3.8-flash" }] }, review: { models: [{ model: "antigravity/gemini-4-argon" }] } },
  };
  const rows = acpRows().map((row) => ({ ...row, included: false }));
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered, catalogRows: rows });
  assert.ok(errors.some((e) => /not included in the .* subscription/.test(e)), errors.join("\n"));
});

test("a dollar budget over a subscription adapter needs an acknowledgment", () => {
  const { dir, config, plan } = fixture();
  const data = {
    ...readCampaign(dir, "demo").data,
    budget: { tokens: null, dollars: 1 },
    runner: { adapter: "agy-acp", spend: "subscription-only" },
    kinds: {
      code: { models: [{ adapter: "agy-acp", model: "antigravity/gemini-3.8-flash" }] },
      review: { models: [{ adapter: "agy-acp", model: "antigravity/gemini-4-argon" }] },
    },
  };
  const rows = rowsFor("agy-acp");
  const rejected = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered, catalogRows: { "agy-acp": rows } });
  assert.ok(rejected.errors.some((e) => /ack_unmetered/.test(e)), rejected.errors.join("\n"));
  const accepted = validateCampaign({
    root: dir,
    consoleConfig: config,
    data: { ...data, budget: { tokens: null, dollars: 1, ack_unmetered: true } },
    tickets: plan.ordered,
    catalogRows: { "agy-acp": rows },
  });
  assert.deepEqual(accepted.errors, []);
});

test("the adapter catalog is visible to the panel and model resolution", () => {
  fixture();
  const view = adaptersView();
  const agy = view.find((a) => a.id === "agy-acp");
  assert.equal(agy.models, 2);
  assert.ok(agy.fetchedAt);
  const row = allModels().find((m) => m.adapter === "agy-acp" && m.model === "gemini-4-argon");
  assert.equal(row.provider, "antigravity");
});

test("OpenCode defaults to subscription-only, pi to metered-ok", () => {
  const pi = runnerConfig({ runner: {} });
  assert.equal(pi.spend, "metered-ok");
  const oc = runnerConfig({ runner: { adapter: "opencode-acp" } });
  assert.equal(oc.spend, "subscription-only");
  const forced = runnerConfig({ runner: { adapter: "opencode-acp", spend: "metered-ok" } });
  assert.equal(forced.spend, "metered-ok");
});
