// Model prices and capability metadata from the local pi model store.
//
// The live catalog (`pi --list-models`) carries context, thinking and image
// support but no price. The model store is the same data pi uses for its own
// picker, and it carries per-1M-token costs and input modalities. Enriching is
// best-effort: an unknown model keeps `price: null`, never a fake zero.
import path from "node:path";
import { home, readJson } from "./util.mjs";

export function modelsStoreFile() {
  return path.join(home(), ".pi", "agent", "models-store.json");
}

export function modelsDevFile() {
  return path.join(process.env.XDG_CACHE_HOME || path.join(home(), ".cache"), "orchestration", "models-dev.json");
}

function number(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function humanTokens(value) {
  const n = number(value);
  if (n == null) return null;
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`.replace(".0M", "M");
  if (n >= 1_000) return `${Math.round((n / 1_000) * 10) / 10}K`.replace(".0K", "K");
  return String(n);
}

/* `models-store.json` has been seen in two shapes: {providers: {...}} and a
   bare map of provider -> {models: [...]}. Accept both. */
/* models.dev: provider -> models -> cost/limit/attachment. Used as the
   fallback for providers the local pi store does not know (openrouter, etc.). */
export function loadModelsDevMap(file = modelsDevFile()) {
  const data = readJson(file, null);
  if (!data || typeof data !== "object") return new Map();
  const map = new Map();
  for (const [provider, entry] of Object.entries(data)) {
    for (const [id, model] of Object.entries(entry?.models || {})) {
      const cost = model.cost && typeof model.cost === "object" ? model.cost : null;
      map.set(`${provider}/${id}`, {
        provider,
        model: id,
        price: cost
          ? {
              input: number(cost.input),
              output: number(cost.output),
              cacheRead: number(cost.cache_read ?? cost.cacheRead),
              cacheWrite: number(cost.cache_write ?? cost.cacheWrite),
              tiers: null,
            }
          : null,
        contextTokens: number(model.limit?.context),
        maxOutTokens: number(model.limit?.output),
        images: model.attachment === true,
        reasoning: model.reasoning === true,
        billing: cost ? "metered" : "unknown",
      });
    }
  }
  return map;
}

export function loadPriceMap(file = modelsStoreFile()) {
  const data = readJson(file, null);
  const map = new Map();
  if (data && typeof data === "object") {
    const providers = data.providers && typeof data.providers === "object" ? data.providers : data;
    for (const [provider, entry] of Object.entries(providers)) {
      for (const model of entry?.models || []) {
        if (!model?.id) continue;
        const cost = model.cost && typeof model.cost === "object" ? model.cost : null;
        map.set(`${provider}/${model.id}`, {
          provider,
          model: model.id,
          price: cost
            ? {
                input: number(cost.input),
                output: number(cost.output),
                cacheRead: number(cost.cacheRead),
                cacheWrite: number(cost.cacheWrite),
                tiers: Array.isArray(cost.tiers) ? cost.tiers : null,
              }
            : null,
          contextTokens: number(model.contextWindow),
          maxOutTokens: number(model.maxTokens),
          images: Array.isArray(model.input) ? model.input.includes("image") : null,
          reasoning: model.reasoning === true,
          billing: cost ? "metered" : "unknown",
        });
      }
    }
  }
  for (const [key, meta] of loadModelsDevMap()) {
    if (!map.has(key)) map.set(key, meta);
  }
  return map;
}

export function enrichModel(row, map) {
  const meta = map.get(`${row.provider}/${row.model}`);
  if (!meta) return { ...row, price: null, billing: row.billing || "unknown" };
  return {
    ...row,
    context: row.context && row.context !== "?" ? row.context : humanTokens(meta.contextTokens),
    contextTokens: meta.contextTokens,
    maxOutTokens: meta.maxOutTokens,
    images: meta.images == null ? row.images : meta.images,
    imagesSource: meta.images == null ? row.imagesSource || null : "model",
    thinking: row.thinking === true || meta.reasoning === true ? true : Boolean(meta.reasoning ?? row.thinking),
    price: meta.price,
    billing: meta.billing,
  };
}

/* A blended list price, per 1M tokens. Agent work reads far more than it
   writes, so input is weighted 4:1. Used for ordering only, never for billing. */
export function priceScore(row) {
  if (!row.price) return Number.POSITIVE_INFINITY;
  return (row.price.input ?? 0) * 4 + (row.price.output ?? 0);
}

export function sortByPrice(rows) {
  return [...rows].sort((a, b) => {
    const left = priceScore(a);
    const right = priceScore(b);
    if (left !== right) return left < right ? -1 : 1;
    return `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`);
  });
}

export function priceLabel(row) {
  if (row.plan === "subscription" || row.billing === "subscription") {
    return row.price ? `included · $${row.price.input ?? 0}/$${row.price.output ?? 0} per 1M` : "included";
  }
  if (!row.price) return "price unknown";
  const input = row.price.input ?? 0;
  const output = row.price.output ?? 0;
  if (input === 0 && output === 0) return "free";
  return `$${input}/$${output} per 1M`;
}
