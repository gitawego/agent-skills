import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { sandbox, project, writeConsole, writeCampaign, writeTicket, MODELS } from "./helpers.mjs";
import { validateCampaign } from "../scripts/lib/config.mjs";
import { loadPlan } from "../scripts/lib/plan.mjs";

const BODY = `## Goal

Ship the thing.

## Brief

Because.

## Acceptance criteria

- [ ] It ships.

## Constraints

None.

## What to read first

- **Files:** README.md
`;

function setup(overrides = {}, campaignPatch = {}) {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  const config = writeConsole(overrides);
  const data = {
    campaign: "demo",
    stage: "awaiting_approval",
    autonomy: "supervised",
    plan_gate: "human",
    landing: "branch",
    base: "main",
    checks: [{ name: "ok", cmd: "true" }],
    budget: { tokens: null, dollars: null },
    max_autoship_lines: 200,
    kinds: { code: { models: [{ model: MODELS.strong, thinking: "high" }] } },
    ...campaignPatch,
  };
  writeCampaign(dir, "demo", data, BODY);
  writeTicket(
    dir,
    "demo",
    "01-work.md",
    { id: "01", kind: "code", touches: ["work/**"] },
    "## What to build\n\nIt.\n\n## Acceptance criteria\n\n- [ ] Works.",
  );
  const plan = loadPlan(dir, "demo");
  return { dir, config, data, plan };
}

test("a valid campaign validates", () => {
  const { dir, config, data, plan } = setup();
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered });
  assert.deepEqual(errors, []);
});

test("an unbound kind is refused with the bind hint", () => {
  const { dir, config, data, plan } = setup({ unbound: true }, { kinds: {} });
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered });
  assert.ok(errors.some((e) => /has no model chain/.test(e)), errors.join("\n"));
});

test("a model outside the catalog is refused", () => {
  const { dir, config, data, plan } = setup({}, { kinds: { code: { models: [{ model: "nope/nope", thinking: "high" }] } } });
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered });
  assert.ok(errors.some((e) => /not in the catalog/.test(e)));
});

test("a review chain on the same model as the work is refused", () => {
  const { dir, config, data, plan } = setup(
    {},
    {
      kinds: {
        code: { models: [{ model: MODELS.strong, thinking: "high" }] },
        review: { models: [{ model: MODELS.strong, thinking: "high" }] },
      },
    },
  );
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered });
  assert.ok(errors.some((e) => /review chain starts with .* the same model as kind "code"/.test(e)), errors.join("\n"));
});

test("a cap above the console cap is refused", () => {
  const { dir, config, data, plan } = setup({}, { kinds: { code: { models: [{ model: MODELS.strong }], max_concurrent: 9 } } });
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered });
  assert.ok(errors.some((e) => /exceeds the console cap/.test(e)));
});

test("a budget above the console ceiling is refused", () => {
  const { dir, config, data, plan } = setup({ limits: { max_concurrent: 4, run_timeout_min: 30, stuck_after_min: 0, max_attempts: 3, budget: { tokens: 100 } } }, { budget: { tokens: 200 } });
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered });
  assert.ok(errors.some((e) => /exceeds the console ceiling/.test(e)));
});

test("a missing base ref is refused", () => {
  const { dir, config, data, plan } = setup({}, { base: "no-such-branch" });
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered });
  assert.ok(errors.some((e) => /does not exist/.test(e)));
});

test("unknown campaign fields and stages are refused", () => {
  const { dir, config, data, plan } = setup({}, { typo_field: 1, stage: "sprinting" });
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered });
  assert.ok(errors.some((e) => /unknown campaign field "typo_field"/.test(e)));
  assert.ok(errors.some((e) => /unknown stage "sprinting"/.test(e)));
});

test("a kind whose tools cannot write a report is refused", () => {
  const { dir, config, data, plan } = setup(
    {},
    { kinds: { review: { models: [{ model: MODELS.backup, thinking: "high" }], tools: "read,grep" } } },
  );
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered });
  assert.ok(errors.some((e) => /no tool that can write a report/.test(e)), errors.join("\n"));
});

test("the review kind must be bound, or nothing can pass its gate", () => {
  const { dir, config, data, plan } = setup({ unbound: true }, { kinds: { code: { models: [{ model: MODELS.strong }] }, review: { models: [] } } });
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered });
  assert.ok(errors.some((e) => /kind "review" has no model chain/.test(e)), errors.join("\n"));
});

test("allow_paths must be a list", () => {
  const { dir, config, data, plan } = setup({}, { allow_paths: "package-lock.json" });
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered });
  assert.ok(errors.some((e) => /allow_paths must be a list/.test(e)));
});

test("protected allow_paths are refused", () => {
  const { dir, config, data, plan } = setup({}, { allow_paths: [".env.local", "orchestration/demo/tickets/01-work.md"] });
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered });
  assert.ok(errors.some((e) => /environment file/.test(e)), errors.join("\n"));
  assert.ok(errors.some((e) => /campaign's own plan and tickets/.test(e)), errors.join("\n"));
});

test("a check without a command is refused", () => {
  const { dir, config, data, plan } = setup({}, { checks: [{ name: "lint" }] });
  const { errors } = validateCampaign({ root: dir, consoleConfig: config, data, tickets: plan.ordered });
  assert.ok(errors.some((e) => /has no command/.test(e)));
});
