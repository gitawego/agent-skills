// Provider plan windows: observed or hand-entered, always labelled with freshness.
export const QUOTA_SOURCES = ["manual", "api", "stale"];
export const DEFAULT_STALE_AFTER_MIN = 24 * 60;

function finite(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function validateQuotas(list) {
  if (list == null) return { quotas: [], errors: [] };
  if (!Array.isArray(list)) return { quotas: [], errors: ["quotas must be a list"] };
  const errors = [];
  const quotas = [];
  list.forEach((raw, index) => {
    const at = `quotas[${index}]`;
    const before = errors.length;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const provider = raw.provider == null ? null : String(raw.provider).trim();
    const adapter = raw.adapter == null ? null : String(raw.adapter).trim();
    if (!provider && !adapter) errors.push(`${at} needs a provider or an adapter`);
    const window = raw.window == null ? "" : String(raw.window).trim();
    if (!window) errors.push(`${at}.window is required (for example 5h or weekly)`);
    const used = finite(raw.used);
    const limit = finite(raw.limit);
    if (used == null || used < 0) errors.push(`${at}.used must be a non-negative number`);
    if (limit == null || limit <= 0) errors.push(`${at}.limit must be a positive number`);
    const resetAt = isoOrNull(raw.resetAt);
    if (raw.resetAt && !resetAt) errors.push(`${at}.resetAt must be an ISO date`);
    const source = raw.source == null ? "manual" : String(raw.source);
    if (!QUOTA_SOURCES.includes(source)) errors.push(`${at}.source must be one of ${QUOTA_SOURCES.join(", ")}`);
    const updatedAt = isoOrNull(raw.updatedAt) || isoOrNull(raw.observedAt);
    if (raw.updatedAt && !isoOrNull(raw.updatedAt)) errors.push(`${at}.updatedAt must be an ISO date`);
    const staleAfterMin = finite(raw.staleAfterMin);
    if (raw.staleAfterMin != null && (staleAfterMin == null || staleAfterMin <= 0))
      errors.push(`${at}.staleAfterMin must be a positive number`);
    if (errors.length > before) return;
    quotas.push({
      provider: provider || null,
      adapter: adapter || null,
      window,
      used,
      limit,
      resetAt: resetAt || null,
      source,
      updatedAt: updatedAt || null,
      staleAfterMin: staleAfterMin || DEFAULT_STALE_AFTER_MIN,
    });
  });
  return { quotas, errors };
}

/* Campaign entries override a console entry with the same provider/adapter/window. */
export function resolveQuotas(consoleConfig, data = {}) {
  const base = validateQuotas(consoleConfig?.quotas || []).quotas;
  const overrides = validateQuotas(data?.quotas || []).quotas;
  const key = (quota) => `${quota.provider || ""}|${quota.adapter || ""}|${quota.window}`;
  const merged = new Map(base.map((quota) => [key(quota), quota]));
  for (const quota of overrides) merged.set(key(quota), quota);
  return [...merged.values()];
}

export function quotaPercent(quota) {
  if (!quota || !quota.limit) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(quota.used) / Number(quota.limit)) * 100)));
}

export function quotaResetPassed(quota, now = Date.now()) {
  return Boolean(quota?.resetAt) && Date.parse(quota.resetAt) <= now;
}

export function quotaExhausted(quota, now = Date.now()) {
  if (!quota) return false;
  if (quotaResetPassed(quota, now)) return false;
  return Number(quota.used) >= Number(quota.limit);
}

export function quotaStale(quota, now = Date.now()) {
  if (!quota) return false;
  if (quota.source === "stale") return true;
  const ref = quota.updatedAt || quota.observedAt;
  if (!ref) return false;
  const age = now - Date.parse(ref);
  return Number.isFinite(age) && age > (quota.staleAfterMin || DEFAULT_STALE_AFTER_MIN) * 60_000;
}

export function quotaMatches(quota, { provider = null, adapter = null } = {}) {
  if (!quota) return false;
  if (quota.provider && quota.provider !== provider) return false;
  if (quota.adapter && quota.adapter !== adapter) return false;
  return Boolean(quota.provider || quota.adapter);
}

/* Stale data is shown but never enforced: a forgotten manual entry must not
   freeze the fleet forever. */
export function quotaBlock(quotas, target, now = Date.now()) {
  return (
    (quotas || []).find(
      (quota) => quotaMatches(quota, target) && quotaExhausted(quota, now) && !quotaStale(quota, now),
    ) || null
  );
}

export function quotaName(quota) {
  return quota?.provider || quota?.adapter || "provider";
}

function humanizeReset(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "reset passed";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, "0")}h`;
}

export function quotaText(quota, now = Date.now()) {
  if (!quota) return "";
  const percent = quotaPercent(quota);
  const reset = quota.resetAt ? `, resets in ${humanizeReset(quota.resetAt)}` : "";
  const stale = quotaStale(quota, now) ? ", stale" : "";
  return `${quotaName(quota)} ${quota.window} at ${percent}%${reset}${stale}`;
}
