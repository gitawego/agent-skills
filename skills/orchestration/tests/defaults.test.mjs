import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_CHAINS,
  compareVersions,
  matchFamily,
  resolveDefaultChains,
} from "../scripts/lib/defaults.mjs";
import { sandbox, project, writeConsole, writeTicket, SKILL } from "./helpers.mjs";
import { applyCommand } from "../scripts/lib/engine.mjs";
import { loadConsole } from "../scripts/lib/config.mjs";

const CLI = path.join(SKILL, "scripts", "orchestrate.mjs");

function row(provider, model, extra = {}) {
  return {
    adapter: "opencode-acp",
    provider,
    model,
    included: true,
    images: true,
    price: { input: 0.1, output: 0.2 },
    ...extra,
  };
}

const ROWS = [
  row("opencode-go", "deepseek-v4.1-flash"),
  row("opencode-go", "deepseek-v4.1-flash-free"),
  row("opencode-go", "deepseek-v4-flash"),
  row("openrouter", "deepseek/deepseek-v4.1-flash", { included: false, price: { input: 0.006, output: 0.5 } }),
  row("opencode-go", "muse-spark-1.2-contributor"),
  row("opencode-go", "muse-spark-1.3-contributor"),
  row("openrouter", "meta/muse-spark-1.3-contributor", { included: false }),
  row("opencode-go", "mimo-v2.5"),
  row("opencode-go", "mimo-v2.6-flash"),
  row("opencode-go", "mimo-v2.6-pro"),
];

const first = (resolved, kind) => resolved.chains[kind]?.models?.[0]?.model;
const models = (resolved, kind) => (resolved.chains[kind]?.models || []).map((entry) => entry.model);

test("model ids map to a family and a release", () => {
  assert.deepEqual(matchFamily("deepseek-v4.1-flash"), {
    family: "deepseek-flash",
    version: "4.1",
    parts: [4, 1],
  });
  assert.equal(matchFamily("deepseek/deepseek-v4.1-flash").family, "deepseek-flash");
  assert.equal(matchFamily("meta/muse-spark-1.3-contributor").family, "muse-contributor");
  assert.equal(matchFamily("mimo-v2.6-flash").family, "mimo-flash");
  assert.equal(matchFamily("mimo-v2.6-pro"), null);
  assert.equal(matchFamily("muse-spark-1.3"), null);
  assert.equal(matchFamily("deepseek-v4.1-flash-free"), null);
  assert.equal(matchFamily("deepseek-v4-flash-vision-exp"), null);
  assert.equal(matchFamily("deepseek-v4.1-flash-1017"), null);
  assert.equal(matchFamily("~deepseek/deepseek-v4-flash-latest"), null);
});

test("versions compare numerically, not as strings", () => {
  assert.ok(compareVersions("4.1", "4") > 0);
  assert.ok(compareVersions("2.10", "2.9") > 0);
  assert.equal(compareVersions("1.3", "1.3.0"), 0);
});

test("the newest stable release wins in every family", () => {
  const resolved = resolveDefaultChains({ rows: ROWS, adapter: "opencode-acp", spend: "metered-ok" });
  assert.equal(first(resolved, "code"), "opencode-go/deepseek-v4.1-flash");
  assert.equal(first(resolved, "review"), "opencode-go/muse-spark-1.3-contributor");
  assert.equal(first(resolved, "research"), "opencode-go/mimo-v2.6-flash");
});

test("a subscription never resolves to a row it does not include", () => {
  const onlyMetered = [row("openrouter", "deepseek/deepseek-v4.1-flash", { included: false })];
  const resolved = resolveDefaultChains({ rows: onlyMetered, adapter: "opencode-acp", spend: "subscription-only" });
  assert.equal(resolved.chains.code, undefined);
  assert.ok(resolved.warnings.some((w) => /deepseek/i.test(w)));
});

test("production kinds refuse free models and visual needs image input", () => {
  const rows = [
    row("opencode-go", "deepseek-v4.1-flash-free"),
    row("opencode-go", "deepseek-v4-flash"),
    row("opencode-go", "deepseek-v4.1-flash", { images: false }),
  ];
  const resolved = resolveDefaultChains({ rows, adapter: "opencode-acp", spend: "metered-ok" });
  assert.equal(first(resolved, "code"), "opencode-go/deepseek-v4.1-flash");
  assert.equal(first(resolved, "visual"), "opencode-go/deepseek-v4-flash");
  assert.equal(
    models(resolveDefaultChains({ rows, adapter: "opencode-acp", spend: "metered-ok" }), "visual")[0],
    "opencode-go/deepseek-v4-flash",
  );
});

test("opencode defaults stay on opencode-go even when a reseller is newer and cheaper", () => {
  const rows = [
    row("opencode-go", "deepseek-v4.1-flash"),
    row("openrouter", "deepseek/deepseek-v4.2-flash", { included: false, price: { input: 0.001, output: 0.002 } }),
  ];
  const resolved = resolveDefaultChains({ rows, adapter: "opencode-acp", spend: "metered-ok" });
  assert.equal(first(resolved, "code"), "opencode-go/deepseek-v4.1-flash");
});

test("an opencode default with no opencode-go release stays unbound", () => {
  const rows = [
    row("openrouter", "meta/muse-spark-1.4-contributor", { included: true, price: { input: 0.01, output: 0.02 } }),
  ];
  const resolved = resolveDefaultChains({ rows, adapter: "opencode-acp", spend: "metered-ok" });
  assert.equal(resolved.chains.review, undefined);
  assert.ok(resolved.warnings.some((w) => /muse/i.test(w)));
});

test("the reviewer never starts on a work kind's first model", () => {
  const resolved = resolveDefaultChains({ rows: ROWS, adapter: "opencode-acp", spend: "metered-ok" });
  const review = first(resolved, "review");
  for (const kind of Object.keys(DEFAULT_CHAINS)) {
    if (kind === "review") continue;
    assert.notEqual(first(resolved, kind), review, `${kind} and review share a first model`);
  }
  assert.ok(models(resolved, "review").length >= 2, "review keeps a fallback");
});

test("a missing family falls through to the next rung", () => {
  const rows = [row("opencode-go", "muse-spark-1.3-contributor")];
  const resolved = resolveDefaultChains({ rows, adapter: "opencode-acp", spend: "metered-ok", kinds: ["code"] });
  assert.deepEqual(models(resolved, "code"), ["opencode-go/muse-spark-1.3-contributor"]);
});

test("a bound work kind on the reviewer family moves the review default", () => {
  const resolved = resolveDefaultChains({
    rows: ROWS,
    adapter: "opencode-acp",
    spend: "metered-ok",
    kinds: ["review"],
    avoid: new Set(["opencode-go/muse-spark-1.3-contributor"]),
  });
  assert.equal(first(resolved, "review"), "opencode-go/deepseek-v4.1-flash");
});

test("a campaign resolves only the kinds it uses", () => {
  const resolved = resolveDefaultChains({
    rows: ROWS,
    adapter: "opencode-acp",
    spend: "metered-ok",
    kinds: ["code", "review"],
  });
  assert.deepEqual(Object.keys(resolved.chains).sort(), ["code", "review"]);
});

test("the panel command fills empty console chains and refuses a no-op", () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole({ unbound: true });
  const first = applyCommand(dir, { type: "defaults.apply", scope: "console" }, loadConsole());
  assert.equal(first.ok, true);
  assert.ok(first.applied.includes("code"));
  assert.throws(
    () => applyCommand(dir, { type: "defaults.apply", scope: "console" }, loadConsole()),
    /already bound/,
  );
});

test("a fresh console is seeded at init", () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  const init = spawnSync(process.execPath, [CLI, "init"], { cwd: dir, encoding: "utf8", env: process.env });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /chains\s+defaulted/);
  const config = JSON.parse(fs.readFileSync(path.join(box, "config", "orchestration", "console.json"), "utf8"));
  assert.equal(config.kinds.code.models[0].model, "opencode-go/deepseek-v4.1-flash");
  assert.equal(config.kinds.research.models[0].model, "opencode-go/mimo-v2.6-flash");
  assert.equal(config.kinds.review.models[0].model, "opencode-go/muse-spark-1.3-contributor");
});

test("defaults --apply on a campaign binds the kinds the plan uses", () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole({ unbound: true });
  assert.equal(spawnSync(process.execPath, [CLI, "init"], { cwd: dir, encoding: "utf8", env: process.env }).status, 0);
  const start = spawnSync(process.execPath, [CLI, "start", "demo", "--campaign", "demo"], {
    cwd: dir,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(start.status, 0, start.stderr);
  writeTicket(
    dir,
    "demo",
    "01-a.md",
    { id: "01", kind: "code", touches: ["src/**"] },
    "## What to build\n\nA.\n\n## Acceptance criteria\n\n- [ ] A.",
  );
  const applied = spawnSync(process.execPath, [CLI, "defaults", "demo", "--apply"], {
    cwd: dir,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(applied.status, 0, applied.stderr);
  const text = fs.readFileSync(path.join(dir, "orchestration", "demo", "campaign.md"), "utf8");
  assert.match(text, /code:/);
  assert.match(text, /opencode-go\/deepseek-v4\.1-flash/);
  assert.match(text, /review:/);
  assert.doesNotMatch(text, /research:/, "an unused kind is not pinned into the campaign");
});

test("init leaves an existing console alone; defaults --apply binds it", () => {
  const box = sandbox();
  const dir = project(path.join(box, "repo"));
  writeConsole({ unbound: true });

  const init = spawnSync(process.execPath, [CLI, "init"], { cwd: dir, encoding: "utf8", env: process.env });
  assert.equal(init.status, 0, init.stderr);
  const before = JSON.parse(fs.readFileSync(path.join(box, "config", "orchestration", "console.json"), "utf8"));
  assert.equal(before.kinds.code.models.length, 0, "init never rewrites a console the person owns");

  const applied = spawnSync(process.execPath, [CLI, "defaults", "--apply"], { cwd: dir, encoding: "utf8", env: process.env });
  assert.equal(applied.status, 0, applied.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(box, "config", "orchestration", "console.json"), "utf8"));
  assert.equal(after.kinds.code.models[0].model, "opencode-go/deepseek-v4.1-flash");
  assert.equal(after.kinds.review.models[0].model, "opencode-go/muse-spark-1.3-contributor");

  const second = spawnSync(process.execPath, [CLI, "defaults", "--apply"], { cwd: dir, encoding: "utf8", env: process.env });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already bound/);
});
