// Discover an ACP adapter's model catalog and print it as JSON.
// Usage: node scripts/acp-catalog.mjs <adapter-id>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, initialize } from "./lib/acp-client.mjs";
import { profile, splitModel } from "./lib/acp-profiles.mjs";
import { enrichModel, loadPriceMap, sortByPrice } from "./lib/pricing.mjs";

const adapter = process.argv[2];
const p = profile(adapter);
const cwd = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), `orch-${adapter}-`));
const cleanup = !process.argv[3];
const client = connect({ command: p.command, args: p.args, cwd, onStderr: () => {} });

function modelsFromOptions(options = []) {
  const byId = Object.fromEntries(options.map((o) => [o.id, o]));
  const modelOption = byId[p.modelConfig];
  const thinkingOption = byId[p.thinkingConfig];
  const values = modelOption?.options || [];
  const levels = (thinkingOption?.options || []).map((o) => o.value);
  return values.map((entry) => {
    const raw = String(entry.value);
    const { provider, model } = splitModel(p, raw);
    return {
      adapter,
      provider,
      model,
      label: entry.name || raw,
      context: null,
      maxOut: null,
      thinking: levels.length > 0,
      thinkingLevels: levels,
      images: null,
      price: null,
      billing: p.billing,
      plan: p.includedProviders ? (p.includedProviders.includes(provider) ? "subscription" : "metered") : "subscription",
      included: p.includedProviders ? p.includedProviders.includes(provider) : true,
    };
  });
}

try {
  await initialize(client, { name: "orchestration-catalog", version: "1" });
  const session = await client.request("session/new", { cwd, mcpServers: [] });
  const rows = modelsFromOptions(session.configOptions);
  const prices = loadPriceMap();
  const enriched = rows.map((row) => {
    const withPrice = enrichModel(row, prices);
    if (p.billing === "subscription") {
      return { ...withPrice, price: null, billing: "subscription", included: true };
    }
    return {
      ...withPrice,
      billing: withPrice.price ? "metered" : "unknown",
      included: p.includedProviders ? p.includedProviders.includes(row.provider) : true,
    };
  });
  if (!enriched.length) throw new Error("the adapter advertised no models");
  console.log(JSON.stringify(sortByPrice(enriched)));
  await client.request("session/close", { sessionId: session.sessionId }).catch(() => {});
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.close();
  if (cleanup) fs.rmSync(cwd, { recursive: true, force: true });
}
