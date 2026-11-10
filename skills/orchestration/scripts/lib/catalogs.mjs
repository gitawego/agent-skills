// Adapter registry + on-disk catalog snapshots.
//
// The panel and validation read snapshots; `refreshCatalog` is the only writer
// and is called from an explicit refresh/bind/approve, never from /api/state.
import crypto from "node:crypto";
import path from "node:path";
import { ensureDir, nowIso, readJson, stateHome, writeJson } from "./util.mjs";
import * as pi from "../adapters/pi.mjs";
import agy from "../adapters/agy-acp.mjs";
import opencode from "../adapters/opencode-acp.mjs";

const REGISTRY = new Map([
  ["pi", pi],
  ["agy-acp", agy],
  ["opencode-acp", opencode],
]);

export const DEFAULT_ADAPTER = "pi";

export function adapterIds() {
  return [...REGISTRY.keys()];
}

export function getAdapter(id) {
  const found = REGISTRY.get(id);
  if (!found) {
    const err = new Error(`unknown adapter "${id}"`);
    err.hint = `one of ${adapterIds().join(", ")}`;
    throw err;
  }
  return found;
}

export function adapterLabel(id) {
  return getAdapter(id).label || id;
}

export function cacheFile(id, root = null) {
  const dir = path.join(stateHome(), "orchestration", "catalogs");
  if (!root) return path.join(dir, `${id}.json`);
  const key = crypto.createHash("sha1").update(String(root)).digest("hex").slice(0, 10);
  return path.join(dir, `${id}-${key}.json`);
}

export function readCatalogCache(id, root = null) {
  return readJson(cacheFile(id, root), null);
}

export function writeCatalogCache(id, models, extra = {}) {
  const fetchedAt = nowIso();
  const record = {
    version: 1,
    adapter: id,
    label: adapterLabel(id),
    adapterVersion: extra.adapterVersion ?? null,
    fetchedAt,
    sourceRoot: extra.cwd || null,
    models,
  };
  /* A project-specific snapshot keeps OpenCode's project-dependent model list
     honest; the adapter-level file is the panel's last-known projection. */
  if (extra.cwd) {
    const file = cacheFile(id, extra.cwd);
    ensureDir(path.dirname(file));
    writeJson(file, record);
  }
  const global = cacheFile(id);
  ensureDir(path.dirname(global));
  writeJson(global, record);
  return global;
}

export function refreshCatalog(id, { cwd } = {}) {
  const adapter = getAdapter(id);
  const models = adapter.listModels({ refresh: true, cwd });
  return writeCatalogCache(id, models, { adapterVersion: safeVersion(adapter), cwd });
}

/* A project-specific row set wins over the panel's last-known snapshot. */
export function rowsFor(id, cwd = null) {
  const adapter = getAdapter(id);
  if (id === "pi") return adapter.listModels();
  const scoped = cwd ? readCatalogCache(id, cwd) : null;
  return scoped?.models || readCatalogCache(id)?.models || [];
}

/* Every known row, tagged with its adapter, for model resolution. */
export function allModels() {
  const rows = [];
  for (const id of adapterIds()) {
    try {
      for (const row of rowsFor(id)) rows.push({ ...row, adapter: row.adapter || id });
    } catch {
      /* an adapter without credentials must not hide the others */
    }
  }
  return rows;
}

export function adaptersView() {
  return adapterIds().map((id) => {
    const adapter = getAdapter(id);
    const cached = readCatalogCache(id);
    const ageMs = cached?.fetchedAt ? Date.now() - Date.parse(cached.fetchedAt) : null;
    return {
      id,
      label: adapter.label || id,
      capabilities: safeCapabilities(adapter),
      adapterVersion: cached?.adapterVersion ?? safeVersion(adapter),
      fetchedAt: cached?.fetchedAt ?? null,
      sourceRoot: cached?.sourceRoot ?? null,
      stale: ageMs == null ? false : ageMs > 60 * 60 * 1000,
      models: cached?.models?.length ?? (id === "pi" ? safeCount(() => rowsFor(id).length) : 0),
    };
  });
}

function safeVersion(adapter) {
  try {
    return adapter.version ? adapter.version() : null;
  } catch {
    return null;
  }
}

function safeCapabilities(adapter) {
  try {
    return adapter.capabilities ? adapter.capabilities() : null;
  } catch {
    return null;
  }
}

function safeCount(fn) {
  try {
    return fn();
  } catch {
    return 0;
  }
}
