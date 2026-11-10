import test from "node:test";
import assert from "node:assert/strict";
import { costOf, summarizeCost, telemetryOf } from "../scripts/lib/telemetry.mjs";

test("cost labels distinguish actual, estimated and included without inventing a bill", () => {
  const actual = costOf({
    usage: { tokens: 100, dollars: 0.01, inputTokens: 60, outputTokens: 40, costFromProvider: true },
    price: { input: 3, output: 15 },
    included: false,
    billing: "metered",
  });
  assert.equal(actual.label, "actual");
  assert.match(actual.text, /\$0\.01 actual/);

  const estimated = costOf({
    usage: { tokens: 1000, dollars: 0, inputTokens: 900, outputTokens: 100, costFromProvider: false },
    price: { input: 3, output: 15 },
    included: false,
    billing: "metered",
  });
  assert.equal(estimated.label, "estimated");
  assert.ok(Math.abs(estimated.value - 0.0042) < 1e-9);
  assert.match(estimated.text, /estimated/);

  const included = costOf({
    usage: { tokens: 1000, dollars: 0, inputTokens: 900, outputTokens: 100, unmetered: true },
    price: { input: 3, output: 15 },
    included: true,
    billing: "subscription",
  });
  assert.equal(included.label, "included");
  assert.match(included.text, /API-equivalent/);
  assert.match(included.text, /not billed/);

  const unknown = costOf({ usage: { tokens: 10 }, price: null, included: false });
  assert.equal(unknown.label, "unknown");
  assert.equal(unknown.text, "cost unknown");
});

test("telemetry derives context share, cache hit and output speed", () => {
  const row = telemetryOf({
    usage: { tokens: 140, inputTokens: 60, outputTokens: 40, cachedReadTokens: 40 },
    contextTokens: 200,
    startedAt: new Date(Date.now() - 2000).toISOString(),
    endedAt: new Date().toISOString(),
  });
  assert.equal(row.promptTokens, 100);
  assert.equal(row.cacheHit, 0.4);
  assert.equal(row.contextShare, 0.5);
  assert.ok(row.tokensPerSecond > 10);
});

test("a ticket rollup keeps the least certain label", () => {
  const rollup = summarizeCost([
    { cost: costOf({ usage: { dollars: 0.01, tokens: 100, costFromProvider: true }, included: false }) },
    { cost: costOf({ usage: { dollars: 0.02, tokens: 300, costFromProvider: false }, included: false }) },
  ]);
  assert.equal(rollup.label, "estimated");
  assert.equal(rollup.value, 0.03);
});
