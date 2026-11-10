import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPriceMap, loadModelsDevMap, enrichModel, priceScore, sortByPrice, priceLabel } from "../scripts/lib/pricing.mjs";

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-price-"));
  const file = path.join(dir, "models-store.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      "opencode-go": {
        models: [
          {
            id: "gemini-4-argon",
            cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
            contextWindow: 1_000_000,
            maxTokens: 65_536,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "deepseek-v4.1-flash",
            cost: { input: 0.15, output: 0.6 },
            contextWindow: 1_000_000,
            maxTokens: 131_072,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "muse-spark-1.3-contributor",
            cost: { input: 0.1, output: 0.2 },
            contextWindow: 1_000_000,
            maxTokens: 131_072,
            input: ["text", "image"],
            reasoning: true,
          },
        ],
      },
    }),
  );
  return file;
}

function row(provider, model) {
  return { provider, model, context: "?", maxOut: "?", thinking: false, images: false };
}

test("the model store supplies price, context and modalities", () => {
  const prices = loadPriceMap(store());
  const gemini = enrichModel(row("opencode-go", "gemini-4-argon"), prices);
  assert.equal(gemini.price.input, 2);
  assert.equal(gemini.price.output, 10);
  assert.equal(gemini.context, "1M");
  assert.equal(gemini.contextTokens, 1_000_000);
  assert.equal(gemini.images, true);
  assert.equal(gemini.billing, "metered");
});

test("an unknown model keeps a null price instead of a fake zero", () => {
  const prices = loadPriceMap(store());
  const unknown = enrichModel(row("nope", "nope"), prices);
  assert.equal(unknown.price, null);
  assert.equal(unknown.billing, "unknown");
  assert.equal(priceLabel(unknown), "price unknown");
  assert.equal(priceScore(unknown), Number.POSITIVE_INFINITY);
});

test("cheapest first, with unknown prices last", () => {
  const prices = loadPriceMap(store());
  const rows = [
    enrichModel(row("opencode-go", "gemini-4-argon"), prices),
    enrichModel(row("nope", "nope"), prices),
    enrichModel(row("opencode-go", "deepseek-v4.1-flash"), prices),
    enrichModel(row("opencode-go", "muse-spark-1.3-contributor"), prices),
  ];
  const ordered = sortByPrice(rows);
  assert.deepEqual(ordered.map((r) => r.model), [
    "muse-spark-1.3-contributor",
    "deepseek-v4.1-flash",
    "gemini-4-argon",
    "nope",
  ]);
  assert.ok(priceScore(ordered[0]) < priceScore(ordered[1]));
});

test("models.dev fills a provider the local store does not know", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-modelsdev-"));
  const file = path.join(dir, "api.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      openrouter: {
        models: {
          "~anthropic/claude-fable-latest": {
            cost: { input: 8, output: 40, cache_read: 0.2, cache_write: 10 },
            limit: { context: 1_000_000, output: 128_000 },
            attachment: true,
            reasoning: true,
          },
        },
      },
    }),
  );
  const map = loadModelsDevMap(file);
  const row = map.get("openrouter/~anthropic/claude-fable-latest");
  assert.equal(row.price.input, 8);
  assert.equal(row.price.cacheRead, 0.2);
  assert.equal(row.contextTokens, 1_000_000);
  assert.equal(row.images, true);
});

test("a subscription model is labelled as included, not as free", () => {
  const sub = { provider: "antigravity", model: "gemini-4-argon", billing: "subscription", price: null };
  assert.equal(priceLabel(sub), "included");
  const included = { provider: "opencode-go", model: "muse", plan: "subscription", price: { input: 0.1, output: 0.2 } };
  assert.equal(priceLabel(included), "included · $0.1/$0.2 per 1M");
  const free = { provider: "opencode", model: "beam-free", billing: "metered", price: { input: 0, output: 0 } };
  assert.equal(priceLabel(free), "free");
});
