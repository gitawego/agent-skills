// Cost and usage labels shared by the panel and the CLI.
//
// A subscription run is never presented as a bill, a provider-reported cost is
// "actual", and a price-table calculation is always "estimated".
function rate(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function money(value) {
  const n = Number(value || 0);
  if (!n) return "$0.00";
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function usageNumbers(run) {
  const usage = run?.usage || {};
  const inputTokens = Number(usage.inputTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);
  const cachedReadTokens = Number(usage.cachedReadTokens || 0);
  const cacheWriteTokens = Number(usage.cacheWriteTokens ?? usage.cachedWriteTokens ?? 0);
  const thoughtTokens = Number(usage.thoughtTokens || 0);
  const tokens = Number(usage.tokens || 0) || inputTokens + outputTokens + cachedReadTokens + thoughtTokens;
  const promptTokens = inputTokens + cachedReadTokens;
  const cacheHit = promptTokens > 0 ? cachedReadTokens / promptTokens : null;
  const started = run?.startedAt ? Date.parse(run.startedAt) : NaN;
  const ended = run?.endedAt ? Date.parse(run.endedAt) : Date.now();
  const seconds = Number.isFinite(started) ? Math.max(0, (ended - started) / 1000) : null;
  const tokensPerSecond = seconds && outputTokens ? outputTokens / seconds : null;
  return {
    tokens,
    inputTokens,
    outputTokens,
    cachedReadTokens,
    cacheWriteTokens,
    thoughtTokens,
    promptTokens,
    cacheHit,
    seconds,
    tokensPerSecond,
  };
}

/* The price table is per million tokens. Cache reads are billed at the cache
   rate when the catalog knows it, otherwise at the input rate. */
export function apiEquivalent(run) {
  const price = run?.price;
  if (!price) return null;
  const usage = usageNumbers(run);
  const input = rate(price.input);
  const output = rate(price.output);
  const cacheRead = rate(price.cacheRead) ?? input;
  const cacheWrite = rate(price.cacheWrite) ?? input;
  if (input == null && output == null) return null;
  const total =
    (usage.inputTokens * (input ?? 0) +
      usage.cachedReadTokens * (cacheRead ?? 0) +
      usage.cacheWriteTokens * (cacheWrite ?? 0) +
      usage.outputTokens * (output ?? 0)) /
    1_000_000;
  return total;
}

export function costOf(run) {
  if (run?.cost && run.cost.label) return run.cost;
  const usage = run?.usage || {};
  const numbers = usageNumbers(run);
  const equivalent = apiEquivalent(run);
  const dollars = Number(usage.dollars || 0);
  const included = run?.included === true || run?.billing === "subscription" || usage.unmetered === true;
  let label = "unknown";
  let value = 0;
  if (usage.costFromProvider === true) {
    label = "actual";
    value = dollars;
  } else if (dollars > 0) {
    label = "estimated";
    value = dollars;
  } else if (included && (numbers.tokens > 0 || equivalent != null)) {
    label = "included";
    value = 0;
  } else if (numbers.tokens > 0 && equivalent != null) {
    label = "estimated";
    value = equivalent;
  } else if (numbers.tokens > 0) {
    label = "unknown";
  }
  return {
    label,
    value,
    dollars,
    apiEquivalent: equivalent,
    included,
    text:
      label === "actual"
        ? `${money(value)} actual`
        : label === "estimated"
          ? `${money(value)} estimated`
          : label === "included"
            ? `included${equivalent != null ? ` · API-equivalent ${money(equivalent)} (not billed)` : ""}`
            : "cost unknown",
  };
}

/* A ticket pays for its work run and every gate run. Mixed evidence keeps the
   least certain label rather than upgrading an estimate to a bill. */
export function summarizeCost(runs) {
  const costs = (runs || []).map(costOf);
  const known = costs.filter((cost) => cost.label !== "unknown");
  if (!known.length) return { label: "unknown", value: 0, apiEquivalent: null, text: "cost unknown", count: costs.length };
  const labels = new Set(known.map((cost) => cost.label));
  const label = labels.has("estimated")
    ? "estimated"
    : labels.has("actual")
      ? "actual"
      : labels.has("included")
        ? "included"
        : "unknown";
  const value = known.filter((cost) => cost.label !== "included").reduce((sum, cost) => sum + cost.value, 0);
  const apiEquivalentTotal = known.reduce((sum, cost) => sum + Number(cost.apiEquivalent || 0), 0);
  const included = labels.has("included");
  return {
    label,
    value,
    apiEquivalent: apiEquivalentTotal || null,
    included,
    count: costs.length,
    text:
      label === "actual"
        ? `${money(value)} actual`
        : label === "estimated"
          ? `${money(value)} estimated`
          : label === "included"
            ? `included${apiEquivalentTotal ? ` · API-equivalent ${money(apiEquivalentTotal)} (not billed)` : ""}`
            : "cost unknown",
  };
}

export function telemetryOf(run) {
  const usage = usageNumbers(run);
  const limit = Number(run?.contextTokens || 0) || null;
  const used = usage.promptTokens || usage.tokens || 0;
  return {
    ...usage,
    contextUsed: used,
    contextLimit: limit,
    contextShare: limit && used ? used / limit : null,
  };
}

export function shortTokens(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`.replace(".0M", "M");
  if (n >= 1_000) return `${Math.round((n / 1_000) * 10) / 10}K`.replace(".0K", "K");
  return String(n);
}

export function moneyText(value) {
  return money(value);
}
