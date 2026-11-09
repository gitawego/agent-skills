import test from "node:test";
import assert from "node:assert/strict";
import { parseYaml, stringifyYaml, splitFrontmatter, updateFrontmatter } from "../scripts/lib/yaml.mjs";

const CAMPAIGN = `campaign: pocket-museum-v4
stage: running
autonomy: trusted
plan_gate: human
landing: branch
base: main
checks:
  - { name: typecheck, cmd: "npm run -s typecheck" }
  - { name: tests, cmd: "npm run -s test -- --run" }
budget: { tokens: 2000000, dollars: null }
max_autoship_lines: 200
kinds:
  code:
    models: [{ model: "test/model-strong", thinking: "high" }, { model: "test/model-fast", thinking: "medium" }]
    max_concurrent: 3
  review:
    models: [{ model: "other/model-backup", thinking: "high" }]
`;

test("parses the campaign shape the skill writes", () => {
  const data = parseYaml(CAMPAIGN);
  assert.equal(data.campaign, "pocket-museum-v4");
  assert.equal(data.stage, "running");
  assert.equal(data.autonomy, "trusted");
  assert.equal(data.checks.length, 2);
  assert.equal(data.checks[0].name, "typecheck");
  assert.equal(data.checks[1].cmd, "npm run -s test -- --run");
  assert.equal(data.budget.tokens, 2000000);
  assert.equal(data.budget.dollars, null);
  assert.equal(data.max_autoship_lines, 200);
  assert.equal(data.kinds.code.models[1].thinking, "medium");
  assert.equal(data.kinds.code.max_concurrent, 3);
});

test("round-trips through the serializer", () => {
  const data = parseYaml(CAMPAIGN);
  const again = parseYaml(stringifyYaml(data));
  assert.deepEqual(again, data);
});

test("parses block sequences of maps and nested lists", () => {
  const text = `list:
  - name: a
    cmd: "x y"
  - name: b
    cmd: z
nested:
  - - inner
    - inner2
empty: []
`;
  const data = parseYaml(text);
  assert.equal(data.list[0].name, "a");
  assert.equal(data.list[0].cmd, "x y");
  assert.equal(data.list[1].cmd, "z");
  assert.deepEqual(data.nested, [["inner", "inner2"]]);
  assert.deepEqual(data.empty, []);
});

test("keeps comments out of quoted values", () => {
  const data = parseYaml('note: "a # b"\nother: c # trailing\n');
  assert.equal(data.note, "a # b");
  assert.equal(data.other, "c");
});

test("rejects an unterminated flow collection", () => {
  assert.throws(() => parseYaml("a: [1, 2\n"), /Unterminated|Unterminated flow/i);
});

test("frontmatter round-trips and patch keeps the body", () => {
  const text = `---\ncampaign: x\nstage: draft\n---\n\n## Goal\n\nShip it.\n`;
  const { data, body } = splitFrontmatter(text);
  assert.equal(data.campaign, "x");
  assert.match(body, /Ship it/);
  const next = updateFrontmatter(text, { stage: "running" });
  const again = splitFrontmatter(next);
  assert.equal(again.data.stage, "running");
  assert.equal(again.data.campaign, "x");
  assert.match(again.body, /Ship it/);
});
