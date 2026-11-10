// Default model chains: the newest stable model of each family, chosen per kind.
//
// A default is a family ladder, never a pinned version. Resolution reads the
// live catalog, takes the newest stable release of the family, and applies the
// same constraints the panel and validation enforce: subscription-only hides
// metered rows, production kinds refuse free/promo models, `visual` needs image
// input, and the reviewer never starts on a model another kind starts on.
import { priceScore } from "./pricing.mjs";

const FAMILIES = {
  "deepseek-flash": {
    label: "DeepSeek Flash",
    pattern: /(?:^|\/)(?:~)?deepseek[-_]?(?:v)?(\d+(?:\.\d+)*)[-_]flash(?:$|[-_.])/i,
  },
  "muse-contributor": {
    label: "Muse Spark Contributor",
    pattern: /(?:^|\/)(?:~)?muse[-_]spark[-_](\d+(?:\.\d+)*)[-_]contributor(?:$|[-_.])/i,
  },
  "mimo-flash": {
    label: "MiMo Flash",
    pattern: /(?:^|\/)(?:~)?mimo[-_]v(\d+(?:\.\d+)*)[-_]flash(?:$|[-_.])/i,
  },
};

/* The families a kind tries, in order. Work kinds start on deepseek/mimo so
   the review ladder (muse) stays an independent first model; a fallback may
   still land on another kind's first model. */
export const DEFAULT_CHAINS = {
  plan: ["deepseek-flash", "muse-contributor"],
  code: ["deepseek-flash", "muse-contributor"],
  design: ["deepseek-flash", "muse-contributor"],
  visual: ["deepseek-flash", "muse-contributor"],
  research: ["mimo-flash", "deepseek-flash"],
  review: ["muse-contributor", "deepseek-flash"],
  chores: ["mimo-flash", "deepseek-flash"],
};

export const DEFAULT_THINKING = {
  plan: "high",
  code: "medium",
  design: "high",
  visual: "medium",
  research: "medium",
  review: "high",
  chores: "medium",
};

/* An adapter may resell one plan and list metered resellers beside it. OpenCode
   is the case that matters: its catalog carries hundreds of OpenRouter rows
   next to a few dozen opencode-go rows, and a default must stay on the plan's
   own provider even when a reseller is a release ahead or cheaper. */
export const DEFAULT_PROVIDERS = {
  "opencode-acp": ["opencode-go"],
};

const PAID_KINDS = new Set(["code", "design", "visual", "review"]);
const UNSTABLE = /(?:^|[-_.])(exp|experimental|preview|alpha|beta|rc|nightly|dev|free|promo)(?:$|[-_.])/i;
/* `-1017` is a date-stamped snapshot of the same release, not a newer one. */
const SNAPSHOT = /-\d{4}$/;
/* `~...-latest` is a moving alias; pinning it would make the default drift. */
const ALIAS = /^~/;

export function familyIds() {
  return Object.keys(FAMILIES);
}

export function familyLabel(id) {
  return FAMILIES[id]?.label || id;
}

export function versionParts(value) {
  return String(value)
    .split(".")
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n));
}

export function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

export function isFree(row) {
  return Boolean(row.price) && (row.price.input ?? 0) === 0 && (row.price.output ?? 0) === 0;
}

export function isStableModel(model) {
  const id = String(model || "").trim();
  if (!id) return false;
  if (ALIAS.test(id) || UNSTABLE.test(id) || SNAPSHOT.test(id)) return false;
  return true;
}

/* The family and release a model id belongs to, or null when it is not one of
   the default families or not a stable release. Handles ids such as
   `deepseek-v4.1-flash` and `deepseek/deepseek-v4.1-flash`. */
export function matchFamily(model) {
  const id = String(model || "").trim();
  if (!isStableModel(id)) return null;
  for (const [family, def] of Object.entries(FAMILIES)) {
    const match = id.match(def.pattern);
    if (match) return { family, version: match[1], parts: versionParts(match[1]) };
  }
  return null;
}

export function modelId(row) {
  return `${row.provider}/${row.model}`;
}

function rank(a, b) {
  const version = compareVersions(b.version, a.version);
  if (version) return version;
  const included = Number(a.row.included === false) - Number(b.row.included === false);
  if (included) return included;
  const left = priceScore(a.row);
  const right = priceScore(b.row);
  if (left !== right && Number.isFinite(left + right)) return left < right ? -1 : 1;
  return modelId(a.row).localeCompare(modelId(b.row));
}

export function familyCandidates(rows, family, { spend = "metered-ok", kind = null, providers = null } = {}) {
  const allowed = providers ? new Set(providers) : null;
  const candidates = [];
  for (const row of rows || []) {
    if (allowed && !allowed.has(row.provider)) continue;
    const match = matchFamily(row.model);
    if (!match || match.family !== family) continue;
    if (spend === "subscription-only" && row.included === false) continue;
    if (PAID_KINDS.has(kind) && isFree(row)) continue;
    if (kind === "visual" && row.images !== true) continue;
    candidates.push({ row, family, version: match.version });
  }
  return candidates.sort(rank);
}

export function bestForFamily(rows, family, options = {}) {
  const { avoid = null } = options;
  for (const candidate of familyCandidates(rows, family, options)) {
    if (avoid && (avoid.has(modelId(candidate.row)) || avoid.has(family))) continue;
    return candidate;
  }
  return null;
}

/* A model on another adapter is the same gate as the model on this one, so an
   avoid set names the family when the id belongs to a default family. */
function avoidSet(values = []) {
  const out = new Set();
  for (const value of values || []) {
    const match = matchFamily(value);
    out.add(match ? match.family : value);
  }
  return out;
}

/* The kinds a default write would touch: empty chains unless `force` replaces
   every one. `target` is the console kinds or a campaign's sparse overrides. */
export function pendingDefaultKinds(target = {}, { force = false, kinds = null } = {}) {
  const ids = Array.isArray(kinds) ? kinds : Object.keys(DEFAULT_CHAINS);
  return force ? [...ids] : ids.filter((id) => !(target[id]?.models || []).length);
}

/* First models of work kinds a default write will not replace. They join the
   reviewer's avoid set so a bound work kind cannot be it. */
export function boundFirstModels(effective = {}, pending = []) {
  const skip = new Set(pending);
  const models = new Set();
  for (const [id, kind] of Object.entries(effective || {})) {
    if (id === "review" || skip.has(id)) continue;
    const model = kind.models?.[0]?.model;
    if (!model) continue;
    models.add(matchFamily(model)?.family || model);
  }
  return models;
}

/* Resolve the chains a default write would make from one adapter's rows.
   `kinds` limits the work (a campaign only needs the kinds its plan uses and
   the review gate). `avoid` adds first models the reviewer must not start on. */
export function resolveDefaultChains({ rows = [], adapter = "pi", spend = "metered-ok", kinds = null, avoid = null } = {}) {
  const wanted = (Array.isArray(kinds) && kinds.length ? kinds : Object.keys(DEFAULT_CHAINS)).filter(
    (id) => DEFAULT_CHAINS[id],
  );
  const chains = {};
  const notes = [];
  const warnings = [];
  const providers = DEFAULT_PROVIDERS[adapter] || null;

  const resolve = (kind, avoid) => {
    const chain = [];
    for (const family of DEFAULT_CHAINS[kind]) {
      const candidate = bestForFamily(rows, family, {
        spend,
        kind,
        providers,
        /* only the first entry must dodge another kind's first model */
        avoid: chain.length === 0 ? avoid : null,
      });
      if (!candidate) continue;
      const id = modelId(candidate.row);
      if (chain.some((entry) => entry.model === id)) continue;
      chain.push({
        adapter: candidate.row.adapter || adapter,
        model: id,
        thinking: DEFAULT_THINKING[kind] || "medium",
      });
      notes.push({
        kind,
        family,
        label: familyLabel(family),
        version: candidate.version,
        model: id,
        included: candidate.row.included !== false,
        price: candidate.row.price || null,
        fallback: chain.length > 1,
      });
    }
    return chain;
  };

  const work = wanted.filter((id) => id !== "review");
  /* a campaign may already bind a work kind to the reviewer's family; those
     first models are avoided too, so the gate stays independent */
  const firsts = avoidSet(avoid);
  for (const kind of work) {
    const chain = resolve(kind);
    if (!chain.length) {
      warnings.push(`no ${familyLabel(DEFAULT_CHAINS[kind][0])} release in the ${adapter} catalog for kind "${kind}"`);
      continue;
    }
    chains[kind] = { models: chain };
    firsts.add(matchFamily(chain[0].model)?.family || chain[0].model);
  }

  if (wanted.includes("review")) {
    let chain = resolve("review", firsts);
    if (!chain.length) {
      chain = resolve("review");
      if (chain.length) {
        warnings.push(
          `review starts on ${chain[0].model}, which another kind also starts on; bind review explicitly`,
        );
      }
    }
    if (chain.length) chains.review = { models: chain };
    else warnings.push(`no ${familyLabel(DEFAULT_CHAINS.review[0])} release in the ${adapter} catalog for kind "review"`);
  }

  return { chains, notes, warnings, adapter, spend };
}
