/* Orchestration panel. No framework, no build step: state in, DOM out. */

const VIEWS = ["fleet", "inbox", "board", "campaign", "acceptance", "settings"];
const FLEET_STATUS = ["all", "running", "queued", "acceptance", "done"];
const STAGES = [
  { id: "blocked", label: "Blocked", family: "idle" },
  { id: "queued", label: "Queued", family: "idle" },
  { id: "working", label: "Working", family: "active" },
  { id: "needs_answer", label: "Waiting for you", family: "person" },
  { id: "needs_changes", label: "Sent back", family: "person" },
  { id: "failed", label: "Failed", family: "person" },
  { id: "done", label: "Done", family: "done" },
  { id: "dropped", label: "Dropped", family: "done" },
];

const params = new URLSearchParams(location.search);
let token = params.get("token") || localStorage.getItem("orch.token") || "";
if (params.get("token")) {
  try {
    localStorage.setItem("orch.token", token);
  } catch {
    /* storage can be blocked; the server sets an HttpOnly cookie either way */
  }
  history.replaceState(null, "", location.pathname + location.hash);
}

const textSize = Number(localStorage.getItem("orch.textSize") || 0);
if (textSize) document.documentElement.style.fontSize = `${textSize}px`;

const forced = params.get("theme");
const savedTheme = localStorage.getItem("orch.theme");
if (forced === "light" || forced === "dark") {
  document.documentElement.dataset.theme = forced;
  localStorage.setItem("orch.theme", forced);
} else {
  /* dark is the house default; light is one click away */
  document.documentElement.dataset.theme = savedTheme === "light" ? "light" : "dark";
}

let state = null;
const initialHash = (() => {
  const raw = location.hash.replace(/^#/, "");
  const [name, query = ""] = raw.split("?");
  return { name, params: new URLSearchParams(query) };
})();
let view = VIEWS.includes(initialHash.name) ? initialHash.name : "fleet";
let fleetStatus = FLEET_STATUS.includes(initialHash.params.get("status")) ? initialHash.params.get("status") : "all";
let fleetProject = initialHash.params.get("project") || "";
let fleetAdapter = initialHash.params.get("adapter") || "";
let fleetQuery = initialHash.params.get("q") || "";
let fleetLimit = 200;
let dispatchModalMode = "paused";
let quotaDraft = {};
let selected = { root: null, campaign: null };
let drawer = null;
let logTimer = null;
let logOffset = 0;
let refreshTimer = null;
let previous = new Map();
let fresh = new Set();
let clock = null;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
let drafts = {};
let clearAfterLoad = new Set();
let lastErrorTs = null;

function clearDrafts(scope) {
  for (const key of Object.keys(drafts)) if (key.startsWith(`${scope}:`)) delete drafts[key];
  if (scope === "console" || scope === "campaign") delete quotaDraft[scope];
}

const app = document.getElementById("app");
const drawerEl = document.getElementById("drawer");
const connEl = document.getElementById("conn");
const connText = document.getElementById("connText");
const campaignsEl = document.getElementById("campaigns");
const crumbsEl = document.getElementById("crumbs");
const tabsEl = document.getElementById("nav");
const tabCount = document.getElementById("tab-count");
const acceptCount = document.getElementById("accept-count");
const dispatchPill = document.getElementById("dispatch-pill");
const signalEl = document.getElementById("signal");
const footState = document.getElementById("foot-state");

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (value) => Number(value || 0).toLocaleString("en-US");
const usd = (value) => {
  const n = Number(value || 0);
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
};
const clockOf = (iso) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";

function api(path, options = {}) {
  const url = new URL(path, location.origin);
  if (token) url.searchParams.set("token", token);
  return fetch(url, { credentials: "same-origin", ...options }).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  });
}

function toast(text) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("on"), 2400);
}

function formBusy() {
  if (document.querySelector(".model-suggest:not([hidden])")) return true;
  const active = document.activeElement;
  if (!active || !active.closest?.("#app")) return false;
  if (active.closest(".model-picker")) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
}

async function load({ quiet = false } = {}) {
  try {
    const next = await api("/api/state");
    state = next;
    const errors = [];
    for (const project of next.projects) {
      for (const campaign of project.campaigns || []) {
        for (const event of campaign.events || []) if (event.type === "error") errors.push(event);
      }
    }
    errors.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    if (lastErrorTs === null) {
      lastErrorTs = errors.length ? errors[errors.length - 1].ts : "";
    } else {
      for (const event of errors) {
        if (event.ts <= lastErrorTs) continue;
        lastErrorTs = event.ts;
        toast(`refused: ${event.data?.message || "the engine said no"}`);
      }
    }
    if (clearAfterLoad.size) {
      for (const scope of clearAfterLoad) clearDrafts(scope);
      clearAfterLoad = new Set();
    }
    connEl.className = "dot live";
    connText.textContent = "live";
    /* A background poll or SSE event must not rebuild the page under a form
       control: that would close the model suggestions and drop typed text. */
    if (formBusy()) return;
    render();
    if (!quiet) {
      /* keep the caret where the person left it */
    }
  } catch (err) {
    connEl.className = "dot dead";
    connText.textContent = err.message.includes("token") ? "token rejected" : "offline";
    if (/token/i.test(err.message)) showLogin();
  }
}

function showLogin() {
  if (document.getElementById("login")) return;
  app.innerHTML = `<div class="empty">
      <h2>Paste the panel link.</h2>
      <p>The panel needs its token once per browser. Copy the URL printed by <span class="mono">orchestrate up</span> — everything from <span class="mono">http://127.0.0.1</span> to the end — or just the token.</p>
      <form id="login" class="answer two" style="max-width:44rem">
        <input name="link" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:4173/?token=…" aria-label="Panel link or token" />
        <button class="btn primary" type="submit">Open the panel</button>
      </form>
    </div>`;
  const form = document.getElementById("login");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const raw = String(new FormData(form).get("link") || "").trim();
    if (!raw) return;
    let value = raw;
    try {
      const parsed = new URL(raw);
      value = parsed.searchParams.get("token") || raw;
    } catch {
      /* it is already a bare token */
    }
    try {
      localStorage.setItem("orch.token", value);
    } catch {
      /* ignore */
    }
    const next = new URL(location.href);
    next.searchParams.set("token", value);
    location.replace(next.toString());
  });
}

function scheduleLoad() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => load(), 120);
}

function campaigns() {
  if (!state) return [];
  return state.projects.flatMap((project) =>
    (project.campaigns || []).map((campaign) => ({ ...campaign, root: project.root, project: project.name })),
  );
}

function campaignOf(root, slug) {
  return campaigns().find((c) => c.root === root && c.slug === slug);
}

function current() {
  return campaignOf(selected.root, selected.campaign) || campaigns()[0] || null;
}

function allOpenItems() {
  return campaigns().flatMap((c) => (c.inbox || []).filter((i) => i.status === "open").map((item) => ({ ...item, campaign: c })));
}

function openItems() {
  return allOpenItems().filter((item) => item.kind !== "review");
}

function acceptanceItems() {
  return allOpenItems()
    .filter((item) => item.kind === "review")
    .sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

function fleetRows() {
  const rows = [];
  for (const c of campaigns()) {
    for (const t of c.tickets || []) {
      rows.push({
        type: "ticket",
        key: `${c.root}:${c.slug}:${t.id}`,
        root: c.root,
        project: c.project,
        campaign: c.slug,
        ticket: t.id,
        title: t.title,
        kind: t.kind,
        stage: t.stage,
        family:
          t.stage === "working"
            ? "active"
            : ["needs_answer", "needs_changes", "failed"].includes(t.stage)
              ? "person"
              : ["done", "dropped"].includes(t.stage)
                ? "done"
                : "idle",
        adapter: t.adapter || c.runner?.adapter || "pi",
        model: t.model || t.run?.model || "",
        queue: t.queue || null,
        updated: t.updated || t.run?.startedAt || null,
        cost: t.cost || null,
        attempts: t.attempts || 0,
        live: t.run?.status === "live",
      });
    }
    for (const item of (c.inbox || []).filter((i) => i.status === "open" && i.kind === "review")) {
      rows.push({
        type: "acceptance",
        key: `${c.root}:${c.slug}:${item.id}`,
        root: c.root,
        project: c.project,
        campaign: c.slug,
        ticket: "",
        item: item.id,
        title: item.title || `${c.slug} is ready`,
        kind: "delivery",
        stage: "acceptance",
        family: "person",
        adapter: c.runner?.adapter || "pi",
        model: "",
        queue: { code: "acceptance", text: `waiting ${elapsed(item.created)}` },
        updated: item.created,
        cost: null,
        live: false,
      });
    }
  }
  return rows;
}

function fleetCounts(rows) {
  const counts = { all: rows.length, running: 0, queued: 0, acceptance: 0, done: 0 };
  for (const row of rows) {
    if (row.type === "acceptance") counts.acceptance++;
    else if (row.stage === "working") counts.running++;
    else if (["queued", "blocked", "needs_changes"].includes(row.stage)) counts.queued++;
    else if (["done", "dropped"].includes(row.stage)) counts.done++;
  }
  return counts;
}

function statusMatches(row, status) {
  if (status === "all") return true;
  if (status === "acceptance") return row.type === "acceptance";
  if (status === "running") return row.type === "ticket" && row.stage === "working";
  if (status === "queued") return row.type === "ticket" && ["queued", "blocked", "needs_changes"].includes(row.stage);
  if (status === "done") return row.type === "ticket" && ["done", "dropped"].includes(row.stage);
  return true;
}

function filteredFleet(rows = fleetRows()) {
  const q = fleetQuery.trim().toLowerCase();
  return rows.filter((row) => {
    if (!statusMatches(row, fleetStatus)) return false;
    if (fleetProject && row.project !== fleetProject && row.root !== fleetProject) return false;
    if (fleetAdapter && row.adapter !== fleetAdapter) return false;
    if (!q) return true;
    return `${row.ticket} ${row.title} ${row.project} ${row.campaign} ${row.adapter} ${row.model} ${row.stage} ${row.queue?.text || ""}`
      .toLowerCase()
      .includes(q);
  });
}

function costText(cost) {
  if (!cost) return "—";
  return cost.text || (cost.label === "unknown" ? "—" : `${usd(cost.value)} ${cost.label}`);
}

function fleetCostText(cost) {
  if (!cost || cost.label === "unknown") return "—";
  if (cost.label === "included") return "included";
  return `${usd(cost.value)} ${cost.label === "actual" ? "actual" : "est."}`;
}

function contextText(run) {
  if (!run) return "";
  const used = Number(run.promptTokens || run.tokens || 0);
  const limit = Number(run.contextTokens || 0);
  if (!used) return "—";
  if (!limit) return `${num(used)} tok · window unknown`;
  return `${((used / limit) * 100).toFixed(1)}% · ${num(used)} / ${shortTokens(limit)}`;
}

function shortTokens(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`.replace(".0M", "M");
  if (n >= 1_000) return `${Math.round((n / 1_000) * 10) / 10}K`.replace(".0K", "K");
  return String(n);
}

function telemetryOf(run) {
  if (!run) return [];
  const rows = [];
  rows.push(["Context", contextText(run)]);
  rows.push([
    "Cache",
    run.cacheHit == null ? "—" : `${(run.cacheHit * 100).toFixed(1)}% cached read (${num(run.cachedReadTokens || 0)} tok)`,
  ]);
  rows.push(["Speed", run.tokensPerSecond == null ? "—" : `${run.tokensPerSecond.toFixed(1)} output tok/s`]);
  rows.push(["Cost", costText(run.cost)]);
  return rows;
}

function ensureSelection() {
  const all = campaigns();
  if (!all.length) {
    selected = { root: null, campaign: null };
    return;
  }
  const found = all.find((c) => c.root === selected.root && c.slug === selected.campaign);
  if (!found) selected = { root: all[0].root, campaign: all[0].slug };
}

function priceScore(row) {
  if (!row.price) return Number.POSITIVE_INFINITY;
  return (row.price.input || 0) * 4 + (row.price.output || 0);
}

function priceLabel(row) {
  if (row.plan === "subscription" || row.billing === "subscription") {
    return row.price ? `included · $${row.price.input || 0}/$${row.price.output || 0} per 1M` : "included";
  }
  if (!row.price) return "price unknown";
  const input = row.price.input || 0;
  const output = row.price.output || 0;
  if (input === 0 && output === 0) return "free";
  return `$${input}/$${output} per 1M`;
}

function catalog() {
  const root = selected?.root || current()?.root || state?.projects?.[0]?.root;
  const scoped = root ? state?.catalogs?.[root] : null;
  const rows = scoped
    ? Object.entries(scoped).flatMap(([adapter, list]) => list.map((row) => ({ ...row, adapter: row.adapter || adapter })))
    : state?.catalog || [];
  return [...rows].sort((a, b) => priceScore(a) - priceScore(b));
}

function modelKey(entry) {
  return `${entry.provider}/${entry.model}`;
}

function draftKey(scope, kind) {
  return `${scope}:${kind}`;
}

function draft(scope, kind, models) {
  const key = draftKey(scope, kind);
  if (!drafts[key])
    drafts[key] = (models || []).map((m) => ({
      adapter: m.adapter || adapterFor(scope),
      model: m.model,
      thinking: m.thinking || "medium",
    }));
  return drafts[key];
}

const adapterChoice = { console: null, campaign: null };
const spendChoice = { console: null, campaign: null };

function adapterFor(scope) {
  if (adapterChoice[scope]) return adapterChoice[scope];
  if (scope === "console") return state?.console?.runner?.adapter || "pi";
  return current()?.runner?.adapter || state?.console?.runner?.adapter || "pi";
}

function spendFor(scope) {
  if (spendChoice[scope]) return spendChoice[scope];
  const explicit = scope === "console" ? state?.console?.runner?.spend : current()?.runner?.spend;
  if (explicit) return explicit;
  const adapter = adapterFor(scope);
  return adapter === "opencode-acp" || adapter === "agy-acp" ? "subscription-only" : "metered-ok";
}

function catalogFor(scope) {
  const spend = spendFor(scope);
  return catalog().filter((row) => spend !== "subscription-only" || row.included !== false);
}

function adapterSelect(scope) {
  const chosen = adapterFor(scope);
  const adapters = state?.adapters?.length
    ? state.adapters
    : [{ id: "pi", label: "pi", models: catalog().length }];
  return `<select name="adapter" data-role="adapter" data-scope="${scope}" aria-label="${scope} adapter">
    ${adapters
      .map(
        (a) =>
          `<option value="${esc(a.id)}" ${a.id === chosen ? "selected" : ""} title="${esc(a.sourceRoot || "")}">${esc(a.label || a.id)}${a.models ? ` · ${a.models} models` : ""}${a.id === "pi" ? "" : a.fetchedAt ? (a.stale ? " · stale" : "") : " · not discovered"}</option>`,
      )
      .join("")}
  </select>`;
}

function spendSelect(scope) {
  const chosen = spendFor(scope);
  return `<select name="spend" aria-label="${scope} spend mode">
    <option value="subscription-only" ${chosen === "subscription-only" ? "selected" : ""}>subscription only</option>
    <option value="metered-ok" ${chosen === "metered-ok" ? "selected" : ""}>metered allowed</option>
  </select>`;
}

function sandboxFor(scope) {
  return (scope === "console" ? state?.console?.runner?.sandbox : current()?.runner?.sandbox) || "auto";
}

function sandboxSelect(scope) {
  const chosen = sandboxFor(scope);
  return `<select name="sandbox" aria-label="${scope} sandbox">
    <option value="auto" ${chosen === "auto" ? "selected" : ""}>auto (bwrap when available)</option>
    <option value="bwrap" ${chosen === "bwrap" ? "selected" : ""}>bwrap</option>
    <option value="none" ${chosen === "none" ? "selected" : ""}>none</option>
  </select>`;
}

function isFree(row) {
  return Boolean(row.price) && (row.price.input || 0) === 0 && (row.price.output || 0) === 0;
}

function modelOptions(scope, kind) {
  const freeAllowed = ["research", "chores", "plan"].includes(kind);
  return catalogFor(scope).filter((row) => freeAllowed || !isFree(row));
}

function chainEditor(scope, kind, models) {
  const selected = draft(scope, kind, models);
  const options = modelOptions(scope, kind);
  const chips = selected.length
    ? selected
        .map(
          (entry, index) => `<span class="model-chip"><span class="m">${esc(entry.adapter ? `${entry.adapter} · ${entry.model}` : entry.model)}</span><span class="t">${esc(entry.thinking || "medium")}</span><button class="x" data-act="chain-remove" data-scope="${scope}" data-kind="${esc(kind)}" data-index="${index}" aria-label="Remove ${esc(entry.model)}">×</button></span>`,
        )
        .join("")
    : `<span class="hint">nothing bound${scope === "console" ? ", so these tickets cannot dispatch" : ""}</span>`;
  return `<div class="chain-editor">
      <div class="model-chips">${chips}</div>
      <div class="chain-add">
        <div class="model-picker" data-scope="${scope}" data-kind="${esc(kind)}">
          <input type="text" data-role="model-search" data-scope="${scope}" data-kind="${esc(kind)}" placeholder="Search ${options.length} models…" autocomplete="off" spellcheck="false" />
          <input type="hidden" data-role="model" data-scope="${scope}" data-kind="${esc(kind)}" />
          <div class="model-suggest" hidden></div>
        </div>
        <select data-role="thinking" data-scope="${scope}" data-kind="${esc(kind)}" aria-label="${esc(kind)} thinking">
          ${THINKING.map((t) => `<option ${t === "high" ? "selected" : ""}>${t}</option>`).join("")}
        </select>
        <button class="btn" data-act="chain-add" data-scope="${scope}" data-kind="${esc(kind)}">Add</button>
        <button class="btn ghost" data-act="chain-cheapest" data-scope="${scope}" data-kind="${esc(kind)}">Cheapest</button>
      </div>
    </div>`;
}

function chainText(models) {
  return (models || []).map((m) => `${m.model}${m.thinking ? `:${m.thinking}` : ""}`).join(", ");
}

function parseChain(text) {
  const parts = String(text || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const out = [];
  for (const part of parts) {
    const match = part.match(/^([^\s:]+)(?::([a-z]+))?$/);
    if (!match) return { error: `"${part}" is not provider/model[:thinking]` };
    out.push({ model: match[1], thinking: match[2] || "medium" });
  }
  return { models: out };
}

function elapsed(since) {
  if (!since) return "";
  const ms = Date.now() - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function until(iso) {
  if (!iso) return "no reset";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "no reset";
  if (ms <= 0) return "reset passed";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, "0")}h`;
}

function quotaView(quota) {
  const used = Number(quota.used || 0);
  const limit = Number(quota.limit || 100);
  const percent = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  const resetAt = quota.resetAt ? Date.parse(quota.resetAt) : null;
  const resetPassed = resetAt && resetAt <= Date.now();
  const exhausted = !resetPassed && used >= limit;
  const reference = quota.updatedAt || quota.observedAt;
  const staleAfter = Number(quota.staleAfterMin || 1440) * 60_000;
  const stale = quota.source === "stale" || (reference && Date.now() - Date.parse(reference) > staleAfter);
  return { percent, exhausted, resetPassed, stale };
}

function quotaStrip(quotas, label = "Provider windows") {
  if (!quotas || !quotas.length) {
    return `<div class="quota-strip empty"><span>${esc(label)}: none configured.</span><button class="btn ghost" data-act="go" data-view="settings">Add a window in Settings</button></div>`;
  }
  return `<div class="quota-strip" aria-label="${esc(label)}">
    <span class="quota-label">${esc(label)}</span>
    ${quotas
      .map((quota) => {
        const view = quotaView(quota);
        const cls = view.stale ? "stale" : view.exhausted ? "exhausted" : view.resetPassed ? "expired" : "fresh";
        return `<span class="quota ${cls}" title="${esc(`${quota.used}/${quota.limit} · ${quota.source}${view.stale ? " · stale data" : ""}`)}">
          <b>${esc(quota.provider || quota.adapter || "provider")}</b>
          <span class="window">${esc(quota.window)}</span>
          <span class="bar"><i style="width:${view.percent}%"></i></span>
          <span class="pct">${view.percent}%</span>
          <span class="reset">${esc(view.resetPassed ? "reset passed" : `resets ${until(quota.resetAt)}`)}</span>
          <span class="source">${esc(view.stale ? "stale" : quota.source)}</span>
        </span>`;
      })
      .join("")}
  </div>`;
}

function dispatchBanner() {
  const dispatch = state?.dispatch;
  if (dispatch?.mode !== "paused") return "";
  return `<div class="dispatch-banner">
    <strong>Dispatch paused.</strong>
    <span>${esc(dispatch.reason || "no reason recorded")} · new runs will not start; live runs continue.</span>
    <button class="btn" data-act="dispatch-open">Resume…</button>
  </div>`;
}

function fleetTabs(counts) {
  const labels = [
    ["all", "All"],
    ["running", "Running"],
    ["queued", "Queued"],
    ["acceptance", "Acceptance"],
    ["done", "Done"],
  ];
  return `<div class="fleet-tabs" role="tablist" aria-label="Fleet status">
    ${labels
      .map(
        ([id, label]) =>
          `<button role="tab" aria-selected="${fleetStatus === id}" data-act="fleet-status" data-status="${id}">${label} <b>${counts[id] || 0}</b></button>`,
      )
      .join("")}
  </div>`;
}

function fleetFilters() {
  const projects = [...new Map(campaigns().map((c) => [c.project, c.root])).entries()];
  const adapters = [...new Set(fleetRows().map((row) => row.adapter).filter(Boolean))].sort();
  return `<div class="fleet-filters">
    <input type="search" data-role="fleet-search" value="${esc(fleetQuery)}" placeholder="Search task, project, model, queue reason…" aria-label="Search the fleet" autocomplete="off" spellcheck="false" />
    <select data-role="fleet-project" aria-label="Filter by project">
      <option value="">all projects</option>
      ${projects.map(([name, root]) => `<option value="${esc(name)}" ${fleetProject === name || fleetProject === root ? "selected" : ""}>${esc(name)}</option>`).join("")}
    </select>
    <select data-role="fleet-adapter" aria-label="Filter by adapter">
      <option value="">all adapters</option>
      ${adapters.map((id) => `<option value="${esc(id)}" ${fleetAdapter === id ? "selected" : ""}>${esc(id)}</option>`).join("")}
    </select>
    <span class="hint" id="fleet-summary"></span>
  </div>`;
}

function viewFleet() {
  if (!campaigns().length) return noCampaigns();
  const rows = fleetRows();
  const counts = fleetCounts(rows);
  return `<h1 class="page">Fleet</h1>
    <p class="lede">Every ticket across every project, with why it is or is not moving. Click a row to open the ticket; acceptance rows open the delivery.</p>
    ${dispatchBanner()}
    ${quotaStrip(state?.console?.quotas || [])}
    ${fleetTabs(counts)}
    ${fleetFilters()}
    <div class="fleet-wrap">
      <table class="fleet-table">
        <thead><tr><th>Task</th><th>Stage / waiting</th><th>Model</th><th class="num">Cost</th><th class="num">Updated</th></tr></thead>
        <tbody id="fleet-body"></tbody>
      </table>
    </div>
    <div id="fleet-more" class="fleet-more"></div>`;
}

function fleetRow(row) {
  const open = row.type === "acceptance"
    ? `data-act="open-acceptance" data-root="${esc(row.root)}" data-campaign="${esc(row.campaign)}" data-item="${esc(row.item)}"`
    : `data-act="open-ticket" data-root="${esc(row.root)}" data-campaign="${esc(row.campaign)}" data-ticket="${esc(row.ticket)}"`;
  const model = row.model ? `${row.adapter} · ${row.model}` : row.adapter;
  return `<tr class="fleet-row" data-family="${esc(row.family)}" tabindex="0" ${open}>
    <td class="task"><span class="id">${esc(row.ticket || "→")}</span><span class="name">${esc(row.title)}</span><span class="where">${esc(row.project)} / ${esc(row.campaign)}${row.kind ? ` · ${esc(row.kind)}` : ""}</span></td>
    <td><span class="badge">${esc(row.stage)}</span>${row.queue?.text ? `<span class="queue">${esc(row.queue.text)}</span>` : ""}</td>
    <td class="mono">${esc(model)}</td>
    <td class="num">${esc(fleetCostText(row.cost))}</td>
    <td class="num">${esc(row.updated ? elapsed(row.updated) : "—")}</td>
  </tr>`;
}

function paintFleet() {
  const body = document.getElementById("fleet-body");
  if (!body) return;
  const rows = filteredFleet();
  const visible = rows.slice(0, fleetLimit);
  body.innerHTML = visible.length
    ? visible.map(fleetRow).join("")
    : `<tr><td colspan="5" class="fleet-empty">No rows match. Try another status, project or search.</td></tr>`;
  const summary = document.getElementById("fleet-summary");
  if (summary) summary.textContent = `${rows.length} shown · ${fleetRows().length} total`;
  const more = document.getElementById("fleet-more");
  if (more) {
    more.innerHTML =
      rows.length > fleetLimit
        ? `<button class="btn" data-act="fleet-more">Load ${Math.min(200, rows.length - fleetLimit)} more</button><span class="hint">${fleetLimit} of ${rows.length} rendered</span>`
        : rows.length > 200
          ? `<span class="hint">All ${rows.length} rows rendered. Server-side query comes beyond 1,000.</span>`
          : "";
  }
  syncFleetUrl();
}

function syncFleetUrl() {
  if (drawer) return;
  const params = new URLSearchParams();
  if (fleetStatus !== "all") params.set("status", fleetStatus);
  if (fleetProject) params.set("project", fleetProject);
  if (fleetAdapter) params.set("adapter", fleetAdapter);
  if (fleetQuery.trim()) params.set("q", fleetQuery.trim());
  const query = params.toString();
  const hash = view === "fleet" ? `#fleet${query ? `?${query}` : ""}` : `#${view}`;
  history.replaceState(null, "", hash);
}

function updateBulkBar() {
  const picks = [...document.querySelectorAll("[data-accept-select]:checked")];
  const button = document.querySelector('[data-act="approve-selected"]');
  const hint = document.getElementById("accept-hint");
  if (!button || !hint) return;
  if (!picks.length) {
    button.disabled = true;
    hint.textContent = "Select one campaign's deliveries.";
    return;
  }
  const campaigns = new Set(picks.map((pick) => `${pick.dataset.root}:${pick.dataset.campaign}`));
  if (campaigns.size > 1) {
    button.disabled = true;
    hint.textContent = "Bulk approval is limited to one campaign.";
    return;
  }
  const over = picks.find((pick) => pick.dataset.under !== "true");
  if (over) {
    button.disabled = true;
    hint.textContent = "This delivery is not eligible for bulk approval; approve it individually.";
    return;
  }
  button.disabled = false;
  hint.textContent = `${picks.length} selected in one campaign, under the autoship line.`;
}

function viewAcceptance(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.campaign.root}:${item.campaign.slug}`;
    if (!groups.has(key)) groups.set(key, { campaign: item.campaign, items: [] });
    groups.get(key).items.push(item);
  }
  const body = items.length
    ? [...groups.values()]
        .map(({ campaign, items: group }) => {
          const stats = campaign.delivery?.stats;
          const lines = Number(stats?.lines || 0);
          const limit = Number(campaign.maxAutoshipLines || 200);
          const under = Boolean(stats) && lines <= limit;
          const unknown = !stats;
          const rule = unknown
            ? "diff not recorded — approve individually"
            : under
              ? "under the autoship line"
              : "over the autoship line — approve individually";
          return `<section class="acceptance-group">
            <header>
              <h2>${esc(campaign.project)} / ${esc(campaign.slug)}</h2>
              <span class="hint">${stats ? `${lines} changed lines · autoship limit ${limit}` : "diff not recorded"} · ${esc(campaign.autonomy)}</span>
            </header>
            ${group
              .map(
                (item) => `<article class="acceptance-card" data-root="${esc(campaign.root)}" data-campaign="${esc(campaign.slug)}" data-item="${esc(item.id)}" data-lines="${lines}" data-limit="${limit}" data-under="${under}">
                  <header>
                    <label class="pick"><input type="checkbox" data-accept-select data-root="${esc(campaign.root)}" data-campaign="${esc(campaign.slug)}" data-item="${esc(item.id)}" data-lines="${lines}" data-limit="${limit}" data-under="${under}" /> select</label>
                    <span class="kind">delivery</span>
                    <span class="where">${esc(campaign.project)} / ${esc(campaign.slug)}</span>
                    <span class="wait">waiting ${esc(elapsed(item.created))}</span>
                  </header>
                  <h2>${esc(item.title || campaign.slug)}</h2>
                  ${item.brief ? `<p class="brief">${esc(item.brief)}</p>` : ""}
                  <div class="acceptance-meta">
                    <span>${stats ? `${num(stats.added)} added, ${num(stats.removed)} removed` : "single-item approval"}</span>
                    <span class="${under ? "ok" : "warn"}">${rule}</span>
                  </div>
                  <textarea data-accept-note="${esc(item.id)}" placeholder="Optional note for the record"></textarea>
                  <div class="actions">
                    <button class="btn primary" data-act="approve-acceptance" data-root="${esc(campaign.root)}" data-campaign="${esc(campaign.slug)}" data-item="${esc(item.id)}">Approve and merge</button>
                    <button class="btn signal" data-act="reject-acceptance" data-root="${esc(campaign.root)}" data-campaign="${esc(campaign.slug)}" data-item="${esc(item.id)}">Send back</button>
                    <button class="btn ghost" data-act="open-campaign" data-root="${esc(campaign.root)}" data-campaign="${esc(campaign.slug)}">Open campaign</button>
                  </div>
                </article>`,
              )
              .join("")}
          </section>`;
        })
        .join("")
    : `<div class="empty"><h2>Nothing is waiting for acceptance.</h2><p>Deliveries appear here when a campaign passes its gates and its landing policy needs a person.</p><button class="btn" data-act="go" data-view="fleet">Back to the fleet</button></div>`;
  return `<h1 class="page">Acceptance${items.length ? ` · ${items.length} waiting` : ""}</h1>
    <p class="lede">Deliveries only. Questions and failures stay in the Inbox. Bulk approval is limited to one campaign and to a diff under its autoship line.</p>
    ${items.length ? `<div class="bulk-bar"><button class="btn primary" data-act="approve-selected" disabled>Approve selected</button><span class="hint" id="accept-hint">Select one campaign's deliveries.</span></div>` : ""}
    ${body}`;
}

/* --- render --------------------------------------------------------------- */

function render() {
  ensureSelection();
  const items = openItems();
  const acceptance = acceptanceItems();
  tabCount.textContent = items.length ? String(items.length) : "";
  acceptCount.textContent = acceptance.length ? String(acceptance.length) : "";
  signalEl.classList.toggle("alert", items.length + acceptance.length > 0);
  footState.textContent = state ? `${campaigns().length} campaign${campaigns().length === 1 ? "" : "s"} · ${state.projects.length} project${state.projects.length === 1 ? "" : "s"}` : "local";
  const theme = document.documentElement.dataset.theme || "dark";
  document.querySelectorAll("[data-act='theme']").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.theme === theme));
  });
  const size = Number(localStorage.getItem("orch.textSize") || 0);
  document.querySelectorAll("[data-act='text-size']").forEach((b) => {
    b.setAttribute("aria-pressed", String(Number(b.dataset.size) === size));
  });
  renderDispatch();

  renderRail();
  renderCrumbs();
  renderTabs();

  if (!state) return;
  if (view === "fleet") {
    app.innerHTML = viewFleet();
    paintFleet();
  } else if (view === "inbox") app.innerHTML = viewInbox(items);
  else if (view === "board") app.innerHTML = viewBoard();
  else if (view === "campaign") app.innerHTML = viewCampaign();
  else if (view === "acceptance") app.innerHTML = viewAcceptance(acceptance);
  else if (view === "settings") app.innerHTML = viewSettings();

  autoSize();
  markFresh();
}

function renderDispatch() {
  const dispatch = state?.dispatch || { mode: "auto", reason: null };
  const paused = dispatch.mode === "paused";
  dispatchPill.textContent = paused ? `Dispatch paused${dispatch.reason ? `: ${dispatch.reason}` : ""}` : "Dispatch auto";
  dispatchPill.classList.toggle("paused", paused);
  dispatchPill.title = paused
    ? "New runs are paused. Live runs continue. Click to resume."
    : "Dispatch is automatic. Click to pause new runs.";
}

function renderRail() {
  if (!campaigns().length) {
    campaignsEl.innerHTML = `<div class="hint" style="padding:6px">No campaigns yet.</div>`;
    return;
  }
  campaignsEl.innerHTML = campaigns()
    .map((c) => {
      const open = c.tickets.filter((t) => t.stage === "working").length;
      const waiting = (c.inbox || []).filter((i) => i.status === "open").length;
      const label = `${c.tickets.length} tickets${open ? ` · ${open} running` : ""}${waiting ? ` · ${waiting} waiting` : ""}`;
      return `<button class="campaign-row" data-stage="${esc(c.stage)}" data-act="select-campaign" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" aria-current="${c.root === selected.root && c.slug === selected.campaign}">
        <span class="name">${esc(c.slug)}</span>
        <span class="state">${esc(c.stage)}</span>
        <span class="sub">${esc(label)}</span>
      </button>`;
    })
    .join("");
}

function renderCrumbs() {
  if (view === "fleet") {
    crumbsEl.innerHTML = `<b>Fleet</b><span>·</span>${campaigns().length} campaign${campaigns().length === 1 ? "" : "s"}<span>·</span>${fleetRows().length} rows`;
    return;
  }
  if (view === "acceptance") {
    crumbsEl.innerHTML = `<b>Acceptance</b><span>·</span>${acceptanceItems().length} waiting`;
    return;
  }
  if (view === "settings") {
    crumbsEl.innerHTML = `<b>Console</b><span>·</span>this machine`;
    return;
  }
  const c = current();
  if (!c) {
    crumbsEl.innerHTML = `<span>no campaign</span>`;
    return;
  }
  const parts = [];
  if (c.project && c.project !== c.slug) parts.push(esc(c.project));
  parts.push(`<b>${esc(c.slug)}</b>`, esc(c.stage));
  crumbsEl.innerHTML = parts.join("<span>·</span>");
}

function renderTabs() {
  tabsEl.querySelectorAll("button[data-view]").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.view === view));
  });
}

function viewInbox(items) {
  const failed = campaigns().flatMap((c) => (c.planErrors || []).map((e) => `${c.slug}: ${e}`));
  const body = items.length
    ? items.map(itemRow).join("")
    : `<div class="empty">
        <h2>Nothing needs you.</h2>
        <p>Every campaign is running on its own. The board shows what is moving.</p>
        <dl class="legend">
          <dt>Question</dt><dd>A worker needs a decision no written source answers.</dd>
          <dt>Failure</dt><dd>Attempts ran out, or a merge would not resolve.</dd>
          <dt>Delivery</dt><dd>Deliveries wait in the Acceptance queue, not here.</dd>
        </dl>
        <button class="btn" data-act="go" data-view="board">Open the board</button>
      </div>`;
  return `${failed.length ? `<div class="errors"><strong>Plan problems</strong><ul>${failed.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
    <h1 class="page">Inbox${items.length ? ` · ${items.length} open` : ""}</h1>
    ${body}`;
}

function itemRow(item) {
  const c = item.campaign;
  const ticket = item.ticket ? c.tickets.find((t) => t.id === item.ticket) : null;
  const attrs = `data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" data-item="${esc(item.id)}" data-ticket="${esc(item.ticket || "")}"`;
  const answerId = `answer-${item.id}`;
  return `<article class="item" data-kind="${esc(item.kind)}">
    <div class="item-head">
      <span class="kind">${esc(item.kind)}</span>
      <span class="where">${esc(c.project)} / ${esc(c.slug)}${item.ticket ? ` / ${esc(item.ticket)}` : ""}</span>
      <span>${esc(clockOf(item.created))}</span>
    </div>
    <h2>${esc(item.title || item.id)}</h2>
    ${item.question?.text ? `<p class="q">${esc(item.question.text)}</p>` : ""}
    ${item.question?.options?.length ? `<p class="hint">options: ${item.question.options.map(esc).join(" · ")}${item.question.default ? ` · default: ${esc(item.question.default)}` : ""}</p>` : ""}
    ${item.brief ? `<p class="brief">${esc(item.brief)}</p>` : ""}
    ${item.findings ? `<details><summary>What it ran into</summary><pre class="log">${esc(item.findings)}</pre></details>` : ""}
    <div class="answer">
      <label class="sr" for="${answerId}">Your decision</label>
      <textarea id="${answerId}" data-answer="${esc(item.id)}" placeholder="${item.kind === "review" ? "Optional note for the record" : "Your decision, in one or two sentences"}"></textarea>
      <button class="btn primary" data-act="answer" ${attrs}>Answer</button>
      ${item.kind === "review" ? `<button class="btn" data-act="approve-item" ${attrs}>Approve</button><button class="btn signal" data-act="reject-item" ${attrs}>Send back</button>` : ""}
      ${ticket ? `<button class="btn ghost" data-act="open-ticket" ${attrs}>Open ticket</button>` : ""}
    </div>
  </article>`;
}

function viewBoard() {
  const c = current();
  if (!c) return noCampaigns();
  const byStage = Object.fromEntries(STAGES.map((s) => [s.id, []]));
  for (const t of c.tickets) (byStage[t.stage] || (byStage[t.stage] = [])).push(t);
  const slots = c.tickets.filter((t) => t.stage === "working").length;
  const bands = STAGES.filter((s) => byStage[s.id]?.length)
    .map((stage) => band(stage, byStage[stage.id]))
    .join("");
  return `${campaignHead(c, slots)}
    ${bands || `<div class="empty"><h2>No tickets yet.</h2><p>Add the first one in the campaign view: a title, what to build, and how it will be judged.</p><button class="btn" data-act="go" data-view="campaign">Open the campaign</button></div>`}
    ${ledger(c)}`;
}

function campaignHead(c, slots) {
  const cap = Math.max(1, state?.console?.limits?.max_concurrent || 4);
  const meter = Array.from({ length: cap }, (_, i) => `<i class="${i < slots ? "on" : ""}"></i>`).join("");
  return `<div class="campaign-head">
      <div class="eyebrow">${esc(c.stage)}${c.reason ? ` · ${esc(c.reason)}` : ""}</div>
      <h1>${esc(c.slug)}</h1>
    </div>
    <div class="campaign-meta">
      <span class="meter" title="${slots} of ${cap} slots busy">${meter}<b>${slots}/${cap}</b> slots</span>
      <span>${esc(c.autonomy)}</span>
      <span>${esc(c.landing)}${c.landing === "branch" ? ` → ${esc(c.base)}` : ""}</span>
      <span>${num(c.spend.tokens)} tok · ${usd(c.spend.dollars)}${c.spend.unmetered ? ` · ${c.spend.unmetered} unmetered` : ""}</span>
      <span class="spacer"></span>
      ${c.stage === "running" ? `<button class="btn" data-act="pause" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}">Pause</button>` : ""}
      ${c.stage === "paused" ? `<button class="btn" data-act="resume" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}">Resume</button>` : ""}
      ${c.stage === "running" ? `<button class="btn" data-act="cancel-campaign" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}">Cancel all</button>` : ""}
      ${c.delivery?.mode === "manual" ? `<button class="btn primary" data-act="deliver" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}">Deliver</button>` : ""}
      ${["delivered", "paused"].includes(c.stage) ? `<button class="btn" data-act="archive-campaign" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}">Archive</button>` : ""}
    </div>`;
}

function eventLine(event) {
  const time = clockOf(event.ts);
  const what = event.type.replace(/^(run|gate|ticket|campaign|inbox|merge|question)\./, "$1 ");
  const detail =
    event.data?.to ||
    event.data?.status ||
    event.data?.model ||
    event.data?.result ||
    event.data?.detail ||
    "";
  return `<li><span class="t">${esc(time)}</span><span class="tk">${esc(event.ticket || "—")}</span><span class="ty">${esc(what)}</span><span class="dt">${esc(String(detail).split("\n")[0].slice(0, 90))}</span></li>`;
}

function ledger(c) {
  const events = (c.events || []).slice(-9).reverse();
  if (!events.length) return "";
  return `<section class="ledger">
      <header><h2>Ledger</h2><span class="hint">newest first · showing ${Math.min(9, c.events.length)} of ${c.events.length}</span></header>
      <ol>${events.map(eventLine).join("")}</ol>
    </section>`;
}

function band(stage, tickets) {
  return `<section class="band" data-family="${esc(stage.family)}">
    <header class="band-head">
      <span class="mark"></span>
      <h2>${esc(stage.label)} <span class="count">${tickets.length}</span></h2>
      <span></span>
    </header>
    <ol class="strips">
      ${tickets.map((t) => strip(t, stage.family)).join("")}
    </ol>
  </section>`;
}

function strip(t, family = "idle") {
  const current = t.run && t.run.status === "live" ? t.run : null;
  const tele = current
    ? `<span class="elapsed" data-since="${esc(current.startedAt)}">${esc(elapsed(current.startedAt))}</span> · ${esc(current.model || "")}`
    : t.waitingOn
      ? `lane ${esc(t.waitingOn)}`
      : `${esc(t.model || "—")}${t.attempts > 1 ? ` · ${t.attempts}×` : ""}`;
  return `<li class="strip${fresh.has(t.id) ? " fresh" : ""}" data-family="${family}" tabindex="0" role="button"
      data-act="open-ticket" data-root="${esc(selected.root)}" data-campaign="${esc(selected.campaign)}" data-ticket="${esc(t.id)}">
      <span class="num">${esc(t.id)}</span>
      <span class="title">${esc(t.title)}</span>
      <span class="kind">${esc(t.kind)}</span>
      <span class="tele">${tele}</span>
    </li>`;
}

/* One state, one set of actions: a button that cannot apply is not shown. */
function campaignActions(c) {
  const root = esc(c.root);
  const slug = esc(c.slug);
  const attrs = `data-root="${root}" data-campaign="${slug}"`;
  const live = c.tickets.filter((t) => t.stage === "working").length;
  const buttons = [`<button class="btn" data-act="save-campaign" ${attrs}>Save campaign</button>`];
  let note = "";

  if (c.stage === "draft") {
    note = "Draft. Fill the goal, add tickets and bind a chain, then approve — nothing dispatches before that.";
  } else if (c.stage === "awaiting_approval") {
    buttons.push(`<button class="btn primary" data-act="approve-campaign" ${attrs}>Approve and dispatch</button>`);
    note = "Plan ready. Approving dispatches the first frontier; nothing has run yet.";
  } else if (c.stage === "running") {
    buttons.push(`<button class="btn primary" data-act="pause" ${attrs}>Pause</button>`);
    buttons.push(`<button class="btn signal" data-act="cancel-campaign" ${attrs}>Cancel all</button>`);
    note = `Running${live ? ` · ${live} live run${live === 1 ? "" : "s"}` : " · no run in flight"}. The supervisor dispatches on its next tick.`;
  } else if (c.stage === "paused") {
    buttons.push(`<button class="btn primary" data-act="resume" ${attrs}>Resume</button>`);
    if (c.delivery?.mode === "manual") buttons.push(`<button class="btn signal" data-act="deliver" ${attrs}>Deliver now</button>`);
    buttons.push(`<button class="btn" data-act="archive-campaign" ${attrs}>Archive</button>`);
    note = `Paused${c.reason ? ` — ${c.reason}` : ""}. Nothing dispatches until you resume.`;
  } else if (c.stage === "delivered") {
    buttons.push(`<button class="btn" data-act="resume" ${attrs}>Reopen to add tickets</button>`);
    buttons.push(`<button class="btn" data-act="archive-campaign" ${attrs}>Archive</button>`);
    note = c.delivery?.mode === "manual"
      ? `Delivered, waiting for you: ${c.delivery.detail || "the branch is ready"}`
      : "Delivered. Archive it when you have finished reading.";
  } else {
    note = "Archived. Reopen a new campaign rather than adding to a closed record.";
  }

  return `<div class="actions">${buttons.join("")}</div>
    <p class="stage-note">${esc(note)}</p>`;
}

function viewCampaign() {
  const c = current();
  if (!c) return noCampaigns();
  const kinds = Object.entries(c.effectiveKinds || {});
  const checks = (c.checks || []).map((k) => `${k.name} | ${k.cmd}`).join("\n");
  return `<div class="campaign-head">
      <div class="eyebrow">${esc(c.stage)}${c.delivery ? ` · delivery ${esc(c.delivery.mode)}` : ""}</div>
      <h1>${esc(c.slug)}</h1>
    </div>
    <div class="campaign-meta"><span class="mono-muted">${esc(c.root)}</span><span class="spacer"></span>
      ${c.stage === "running" ? `<button class="btn" data-act="pause" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}">Pause</button>` : ""}
      ${c.stage === "paused" ? `<button class="btn" data-act="resume" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}">Resume</button>` : ""}
    </div>
    ${quotaStrip(c.quotas || [], "Quotas")}
    ${c.planErrors?.length ? `<div class="errors"><strong>Cannot dispatch yet</strong><ul>${c.planErrors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
    <div class="campaign-grid">
      <div class="doc-col">
        <h2>Goal</h2>
        <textarea class="doc" name="goal" rows="2" aria-label="Goal">${esc(c.goal)}</textarea>
        <h2>Brief</h2>
        <textarea class="doc" name="brief" rows="6" aria-label="Brief">${esc(c.brief)}</textarea>
        <h2>Acceptance criteria</h2>
        <textarea class="doc" name="criteria" rows="6" aria-label="Acceptance criteria">${esc(c.criteria)}</textarea>
        <h2>Constraints</h2>
        <textarea class="doc" name="constraints" rows="4" aria-label="Constraints">${esc(c.constraints)}</textarea>
        <h2>What to read first</h2>
        <textarea class="doc" name="reading" rows="4" aria-label="What to read first">${esc(c.reading)}</textarea>
      </div>
      <div class="ops">
        <div class="group">
          <h3>Delivery</h3>
          <div class="field"><label for="autonomy">Autonomy</label><div class="stack">
            <select id="autonomy" name="autonomy">
              ${["supervised", "trusted", "unattended"].map((v) => `<option ${c.autonomy === v ? "selected" : ""}>${v}</option>`).join("")}
            </select>
            <span class="sub">supervised: you take every delivery. trusted: verified work under the limit ships. unattended: anything that passes ships.</span>
          </div></div>
          <div class="field"><label for="plan_gate">Plan gate</label><div class="stack">
            <select id="plan_gate" name="plan_gate">${["human", "auto"].map((v) => `<option ${c.planGate === v ? "selected" : ""}>${v}</option>`).join("")}</select>
            <span class="sub">human: dispatch waits for approval.</span>
          </div></div>
          <div class="field"><label for="landing">Landing</label><div class="stack">
            <select id="landing" name="landing">${["branch", "directory"].map((v) => `<option ${c.landing === v ? "selected" : ""}>${v}</option>`).join("")}</select>
          </div></div>
          <div class="field"><label for="base">Base</label><input id="base" name="base" type="text" value="${esc(c.base)}" /></div>
          <div class="field"><label>Adapter</label><div class="stack">${adapterSelect("campaign")}<span class="sub">models, tools and billing of this campaign</span></div></div>
          <div class="field"><label>Spend</label><div class="stack">${spendSelect("campaign")}<span class="sub">subscription-only hides metered models</span></div></div>
          <div class="field"><label>Sandbox</label><div class="stack">${sandboxSelect("campaign")}<span class="sub">bwrap isolates writes on Linux</span></div></div>
          <div class="field"><label for="autoship">Autoship</label><div class="stack">
            <input id="autoship" name="max_autoship_lines" type="number" min="0" value="${c.maxAutoshipLines}" />
            <span class="sub">changed lines above this never ship without you.</span>
          </div></div>
          <div class="field"><label for="bt">Budget</label><div class="stack">
            <div style="display:flex;gap:8px">
              <input id="bt" name="budget_tokens" type="number" min="0" placeholder="tokens" value="${c.budget?.tokens ?? ""}" />
              <input name="budget_dollars" type="number" min="0" step="0.01" placeholder="dollars" value="${c.budget?.dollars ?? ""}" />
            </div>
            <span class="sub">${budgetEstimate(c) || (c.runner?.adapter && c.runner.adapter !== "pi" && c.budget?.dollars ? "A dollar budget cannot cap a subscription adapter; check the acknowledgment." : "empty: no ceiling.")}</span>
            <label class="sub" style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="budget_ack" ${c.budget?.ack_unmetered ? "checked" : ""}/> acknowledge unmetered adapters</label>
          </div></div>
        </div>

        <div class="group">
          <h3>Generated paths <span class="sub">never counted as drift</span></h3>
          <input name="allow_paths" type="text" value="${esc((c.allowPaths || []).join(", "))}" placeholder="package-lock.json, snapshots/**" aria-label="Generated paths" />
          <p class="sub" style="margin:6px 0 0">Lockfiles, snapshots and other files a worker regenerates without declaring them.</p>
        </div>

        <div class="group">
          <h3>Checks</h3>
          <textarea class="mono" name="checks" rows="3" placeholder="tests | node --test" aria-label="Checks">${esc(checks)}</textarea>
          <p class="sub" style="margin:6px 0 0">One per line, <span class="mono">name | command</span>. The supervisor runs them in the ticket's worktree.</p>
        </div>

        <div class="group">
          <h3>Provider quotas <span class="sub">campaign additions and overrides</span></h3>
          ${quotaEditor("campaign")}
        </div>

        ${campaignActions(c)}
      </div>
    </div>

    <section class="chains">
      <header><h2 class="page">Model chains</h2><span class="hint">first model starts the ticket; each next one is the fallback</span><button class="btn" data-act="refresh-catalog" data-scope="campaign">Refresh models</button></header>
      <div class="chain-grid">
        ${kinds
          .map(
            ([id, kind]) => `<div class="chain-row">
              <span class="name">${esc(id)}</span>
              <div>
                ${chainEditor("campaign", id, kind.models)}
                <span class="sub">${kind.overridden ? "set for this campaign" : "from the console"} · cap ${kind.max_concurrent}</span>
              </div>
            </div>`,
          )
          .join("")}
      </div>
    </section>

    <h2 class="page" style="margin-top:34px">Tickets</h2>
    <div class="ticket-head"><span>#</span><span>Title</span><span>Kind</span><span class="tele">State</span></div>
    <ol class="strips">
      ${c.tickets
        .map(
          (t) => `<li class="strip" tabindex="0" role="button" data-act="open-ticket" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" data-ticket="${esc(t.id)}">
            <span class="num">${esc(t.id)}</span>
            <span class="title">${esc(t.title)}</span>
            <span class="kind">${esc(t.kind)}</span>
            <span class="tele">${esc(t.stage)}${t.blockedBy?.length ? ` · blocked by ${esc(t.blockedBy.join(", "))}` : ""}</span>
          </li>`,
        )
        .join("") || `<li class="strip"><span></span><span class="hint">No tickets yet.</span><span></span><span></span></li>`}
    </ol>

    <section class="chains" style="margin-top:2rem">
      <header><h2 class="page">Decisions</h2><span class="hint">written by you or the orchestrator · read by every worker on these paths</span></header>
      <ol class="decision-list">
        ${(c.decisions || []).length
          ? c.decisions
              .map(
                (d) => `<li>
                  <span class="scope">${esc(d.scope === "console" ? "shared" : d.by)}</span>
                  <span class="text">${esc(d.text)}</span>
                  <span class="cite">${esc(d.cite || "")}</span>
                  ${d.scope === "campaign" ? `<button class="btn ghost" data-act="promote" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" data-id="${esc(d.id)}">share</button>` : ""}
                </li>`,
              )
              .join("")
          : `<li class="empty"><span class="text">Nothing yet. Answers to worker questions land here, and every worker on these paths reads them.</span></li>`}
      </ol>
    </section>

    <details class="new-ticket" ${c.tickets.length ? "" : "open"}>
      <summary>New ticket</summary>
      <div class="grid">
        <div class="field" style="grid-template-columns:88px 1fr"><label for="t-title">Title</label><input id="t-title" name="t_title" type="text" placeholder="What this slice delivers" /></div>
        <div class="field" style="grid-template-columns:88px 1fr"><label for="t-kind">Kind</label>
          <select id="t-kind" name="t_kind">${Object.keys(c.effectiveKinds || {}).map((k) => `<option ${k === "code" ? "selected" : ""}>${esc(k)}</option>`).join("")}</select>
        </div>
        <div class="field" style="grid-template-columns:88px 1fr"><label for="t-blocked">Blocked by</label><input id="t-blocked" name="t_blocked" type="text" placeholder="01, 03" /></div>
        <div class="field" style="grid-template-columns:88px 1fr"><label for="t-touches">Touches</label><input id="t-touches" name="t_touches" type="text" placeholder="src/api/**, docs/**" /></div>
        <div class="field" style="grid-template-columns:88px 1fr"><label for="t-attachments">Files</label><input id="t-attachments" name="t_attachments" type="text" placeholder="orchestration/<campaign>/attachments/ref.png or spec.pdf" /></div>
        <div class="field" style="grid-template-columns:88px 1fr"><label for="t-files">Upload</label><input id="t-files" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" multiple data-role="attach-files" data-target="t_attachments" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" /></div>
      </div>
      <div class="field" style="grid-template-columns:88px 1fr"><label for="t-what">What to build</label><textarea id="t-what" name="t_what" rows="3" placeholder="The end-to-end behaviour, from the user's side."></textarea></div>
      <div class="field" style="grid-template-columns:88px 1fr"><label for="t-accept">Acceptance</label><textarea id="t-accept" name="t_accept" rows="3" placeholder="One checkable outcome per line."></textarea></div>
      <div class="actions" style="margin-top:4px">
        <button class="btn primary" data-act="add-ticket" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}">Add ticket</button>
        <span class="hint">It lands in <span class="mono">orchestration/${esc(c.slug)}/tickets/</span> with the next number.</span>
      </div>
    </details>`;
}

function budgetEstimate(c) {  const budget = c.budget?.tokens;
  if (!budget) return null;
  const scores = [];
  for (const kind of Object.values(c.effectiveKinds || {})) {
    for (const entry of kind.models || []) {
      const row = catalog().find((candidate) => (candidate.adapter || "pi") === (entry.adapter || c.runner?.adapter || "pi") && `${candidate.provider}/${candidate.model}` === entry.model);
      const score = row ? priceScore(row) : Number.POSITIVE_INFINITY;
      if (Number.isFinite(score)) scores.push(score);
    }
  }
  if (!scores.length) return null;
  const low = (budget * Math.min(...scores)) / 1_000_000;
  const high = (budget * Math.max(...scores)) / 1_000_000;
  return `${budget.toLocaleString()} tokens ≈ $${low.toFixed(2)}–$${high.toFixed(2)} at the bound prices`;
}

function quotaSourceRows(scope) {
  if (scope === "console") return state?.console?.quotas || [];
  return current()?.campaignQuotas || [];
}

function quotaRows(scope) {
  const key = scope === "console" ? "console" : "campaign";
  if (!quotaDraft[key]) quotaDraft[key] = quotaSourceRows(scope).map((quota) => ({ ...quota }));
  return quotaDraft[key];
}

function readQuotaRows(scope) {
  const rows = [...document.querySelectorAll(`[data-quota-scope="${scope}"]`)];
  return rows.map((row) => {
    const read = (field) => row.querySelector(`[data-quota-field="${field}"]`)?.value ?? "";
    const adapter = read("adapter").trim();
    return {
      provider: read("provider").trim() || null,
      adapter: adapter || null,
      window: read("window").trim() || "weekly",
      used: Number(read("used") || 0),
      limit: Number(read("limit") || 100),
      resetAt: read("resetAt").trim() || null,
      source: read("source") || "manual",
      updatedAt: new Date().toISOString(),
    };
  });
}

function quotaEditor(scope) {
  const rows = quotaRows(scope);
  return `<div class="quota-editor" id="quota-editor-${scope}">
    <div class="quota-editor-head"><span>provider</span><span>adapter</span><span>window</span><span>used</span><span>limit</span><span>resets (ISO)</span><span>source</span><span></span></div>
    ${rows
      .map(
        (quota, index) => `<div class="quota-row" data-quota-scope="${scope}">
          <input data-quota-field="provider" value="${esc(quota.provider || "")}" placeholder="opencode-go" aria-label="Provider" />
          <input data-quota-field="adapter" value="${esc(quota.adapter || "")}" placeholder="optional (agy-acp)" aria-label="Adapter" />
          <input data-quota-field="window" value="${esc(quota.window || "weekly")}" placeholder="5h" aria-label="Window" />
          <input data-quota-field="used" type="number" min="0" value="${esc(quota.used ?? 0)}" aria-label="Used" />
          <input data-quota-field="limit" type="number" min="1" value="${esc(quota.limit ?? 100)}" aria-label="Limit" />
          <input data-quota-field="resetAt" value="${esc(quota.resetAt || "")}" placeholder="2026-11-10T15:00:00Z" aria-label="Reset at" />
          <select data-quota-field="source" aria-label="Source">
            ${["manual", "api", "stale"].map((source) => `<option ${quota.source === source ? "selected" : ""}>${source}</option>`).join("")}
          </select>
          <button class="btn ghost" data-act="quota-remove" data-scope="${scope}" data-index="${index}" aria-label="Remove quota">×</button>
        </div>`,
      )
      .join("")}
    <div class="actions">
      <button class="btn" data-act="quota-add" data-scope="${scope}">Add window</button>
      <span class="hint">Stale entries are visible but never block dispatch. A reset time in the past clears the window.</span>
    </div>
  </div>`;
}

function refreshQuotaEditor(scope) {
  const el = document.getElementById(`quota-editor-${scope}`);
  if (el) el.outerHTML = quotaEditor(scope);
}

function viewSettings() {
  const cfg = state.console;
  return `<div class="campaign-head"><div class="eyebrow">console · this machine</div><h1>Settings</h1></div>
  <p class="lede">Defaults for every campaign. A campaign can tighten a cap and replace a chain; it cannot loosen what is set here.</p>

  <section class="settings-block">
    <header><h2 class="page">Limits</h2><span class="hint">one slot per live run · extra slot for your own resumes</span></header>
    <div class="limit-grid">
      <label class="num-field"><span>Max concurrent</span><input name="limit_max" type="number" min="1" value="${cfg.limits.max_concurrent}" /></label>
      <label class="num-field"><span>Run timeout, min</span><input name="limit_timeout" type="number" min="1" value="${cfg.limits.run_timeout_min}" /></label>
      <label class="num-field"><span>Stuck after, min</span><input name="limit_stuck" type="number" min="0" value="${cfg.limits.stuck_after_min}" /></label>
      <label class="num-field"><span>Attempts per ticket</span><input name="limit_attempts" type="number" min="1" value="${cfg.limits.max_attempts}" /></label>
    </div>
    <div class="actions">
      <button class="btn primary" data-act="save-settings">Save settings</button>
      <button class="btn" data-act="refresh-catalog" data-scope="console">Refresh catalog</button>
    </div>
  </section>

  <section class="settings-block">
    <header><h2 class="page">Runner</h2><span class="hint">one agent tool per campaign</span></header>
    <div class="limit-grid">
      <label class="num-field"><span>Adapter</span>${adapterSelect("console")}</label>
      <label class="num-field"><span>Spend</span>${spendSelect("console")}</label>
      <label class="num-field"><span>Sandbox</span>${sandboxSelect("console")}</label>
    </div>
    <p class="note" style="margin:8px 0 0">Subscription-only hides metered models; metered-ok shows every discovered model with its price. Changing the adapter changes which catalog the chains below can pick from.</p>
  </section>

  <section class="settings-block">
    <header><h2 class="page">Provider quotas</h2><span class="hint">windows that hold back dispatch when exhausted</span></header>
    <p class="note" style="margin:-4px 0 12px">Match a model by provider, or by adapter for a whole subscription. A campaign can add its own windows in Campaign → Provider quotas. Stale data is displayed but never enforced.</p>
    ${quotaEditor("console")}
  </section>

  <section class="settings-block">
    <header><h2 class="page">Ticket kinds</h2><span class="hint">first model starts the ticket; each next one is the fallback</span></header>
    <p class="note" style="margin:-4px 0 12px">Models come from the selected adapter's catalog, enriched with price and modalities; cheapest capable first. ${catalog().length} available right now. ${catalog().length ? "" : "Run <span class=\"mono\">orchestrate catalog --refresh</span> once credentials are set."}</p>
    <div class="kind-grid">
      ${Object.entries(cfg.kinds || {})
        .map(
          ([id, kind]) => `<div class="kind-row">
            <span class="name">${esc(id)}</span>
            <div class="kind-chain">${chainEditor("console", id, kind.models)}</div>
            <input name="kind_cap_${esc(id)}" type="number" min="1" value="${kind.max_concurrent}" aria-label="${esc(id)} concurrency" />
            <span class="desc">${esc(kind.description || "")}</span>
          </div>`,
        )
        .join("")}
    </div>
    <div class="actions"><button class="btn primary" data-act="save-settings">Save settings</button><button class="btn" data-act="refresh-catalog" data-scope="console">Refresh catalog</button></div>
  </section>`;
}

function noCampaigns() {
  return `<div class="empty">
      <h2>No campaigns yet.</h2>
      <p>A campaign is one goal, a set of tickets, and the models that build them. Start one here, or from a project with <span class="mono">orchestrate start "&lt;goal&gt;"</span>.</p>
      <button class="btn primary" data-act="new-campaign">New campaign</button>
    </div>`;
}

function newCampaignForm() {
  return `<h1 class="page">New campaign</h1>
    <p class="lede">Name the outcome in one sentence. The plan and its tickets come next, before anything is dispatched.</p>
    <div class="campaign-grid">
      <div class="doc-col">
        <div class="field" style="grid-template-columns:110px 1fr"><label for="nc-goal">Goal</label><textarea id="nc-goal" name="nc_goal" rows="2" placeholder="A zero-dependency CLI that logs habits and prints streaks."></textarea></div>
        <div class="field" style="grid-template-columns:110px 1fr"><label for="nc-slug">Name</label><input id="nc-slug" name="nc_slug" type="text" placeholder="from the goal" /></div>
        <div class="field" style="grid-template-columns:110px 1fr"><label for="nc-root">Project</label>
          <select id="nc-root" name="nc_root">${state.projects.map((p) => `<option value="${esc(p.root)}">${esc(p.name)} — ${esc(p.root)}</option>`).join("")}</select>
        </div>
      </div>
      <div class="ops">
        <div class="field"><label for="nc-autonomy">Autonomy</label><select id="nc-autonomy" name="nc_autonomy"><option>supervised</option><option selected>trusted</option><option>unattended</option></select></div>
        <div class="field"><label for="nc-landing">Landing</label><select id="nc-landing" name="nc_landing"><option selected>branch</option><option>directory</option></select></div>
        <div class="field"><label for="nc-base">Base</label><input id="nc-base" name="nc_base" type="text" value="main" /></div>
        <div class="actions"><button class="btn primary" data-act="create-campaign">Create campaign</button><button class="btn ghost" data-act="go" data-view="board">Cancel</button></div>
      </div>
    </div>`;
}

/* --- interaction ---------------------------------------------------------- */

function value(name) {
  const el = document.querySelector(`[name="${name}"]`);
  return el ? el.value : "";
}

async function command(root, body) {
  try {
    await api("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, root, ...body }),
    });
    toast(`${body.type.replace(/\./g, " ")} queued`);
    setTimeout(() => load(), body.type === "catalog.refresh" ? 3500 : 350);
    setTimeout(() => load({ quiet: true }), 2600);
  } catch (err) {
    toast(err.message);
  }
}

function saveCampaign(root, slug) {
  const c = campaignOf(root, slug);
  if (!c) return;
  const body = [
    "## Goal",
    "",
    value("goal"),
    "",
    "## Brief",
    "",
    value("brief"),
    "",
    "## Acceptance criteria",
    "",
    value("criteria"),
    "",
    "## Constraints",
    "",
    value("constraints"),
    "",
    "## What to read first",
    "",
    value("reading"),
    "",
  ].join("\n");
  const checks = value("checks")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split("|");
      return { name: name.trim(), cmd: rest.join("|").trim() };
    });
  const kinds = {};
  for (const [id, kind] of Object.entries(c.effectiveKinds || {})) {
    const models = draft("campaign", id, kind.models);
    const before = JSON.stringify(kind.models.map((m) => ({ adapter: m.adapter || null, model: m.model, thinking: m.thinking || "medium" })));
    if (kind.overridden || JSON.stringify(models) !== before) kinds[id] = { models };
  }
  clearAfterLoad.add("campaign");
  const patch = {
    autonomy: value("autonomy"),
    plan_gate: value("plan_gate"),
    landing: value("landing"),
    base: value("base"),
    runner: { adapter: value("adapter") || adapterFor("campaign"), spend: value("spend") || "metered-ok", sandbox: value("sandbox") || "auto" },
    checks,
    allow_paths: value("allow_paths")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    budget: {
      tokens: value("budget_tokens") ? Number(value("budget_tokens")) : null,
      dollars: value("budget_dollars") ? Number(value("budget_dollars")) : null,
      ack_unmetered: Boolean(document.querySelector('[name="budget_ack"]')?.checked),
    },
    max_autoship_lines: Number(value("max_autoship_lines") || 200),
    quotas: readQuotaRows("campaign"),
    kinds,
  };
  return command(root, { type: "campaign.save", campaign: slug, patch, body });
}

function saveSettings() {
  const kinds = {};
  for (const [id, kind] of Object.entries(state.console.kinds || {})) {
    kinds[id] = {
      models: draft("console", id, kind.models),
      max_concurrent: Number(value(`kind_cap_${id}`) || kind.max_concurrent),
    };
  }
  clearAfterLoad.add("console");
  return command(campaigns()[0].root, {
    type: "settings.save",
    patch: {
      limits: {
        max_concurrent: Number(value("limit_max")),
        run_timeout_min: Number(value("limit_timeout")),
        stuck_after_min: Number(value("limit_stuck")),
        max_attempts: Number(value("limit_attempts")),
      },
      kinds,
      runner: {
        adapter: value("adapter") || adapterFor("console"),
        spend: value("spend") || "metered-ok",
        sandbox: value("sandbox") || "auto",
      },
      quotas: readQuotaRows("console"),
    },
  });
}

function addTicket(root, slug) {
  const title = value("t_title").trim();
  if (!title) return toast("Give the ticket a title");
  const touches = value("t_touches")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const blockedBy = value("t_blocked")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const criteria = value("t_accept")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const attachments = value("t_attachments")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return command(root, {
    type: "ticket.add",
    campaign: slug,
    title,
    kind: value("t_kind"),
    blocked_by: blockedBy,
    touches,
    attachments,
    what: value("t_what") || title,
    criteria,
  });
}

function createCampaign() {
  const goal = value("nc_goal").trim();
  if (!goal) return toast("Give the campaign a goal");
  const root = value("nc_root");
  if (!root) return toast("Pick a project");
  return command(root, {
    type: "campaign.create",
    goal,
    slug: value("nc_slug").trim() || undefined,
    autonomy: value("nc_autonomy"),
    landing: value("nc_landing"),
    base: value("nc_base") || "main",
  });
}

function autoSize() {
  document.querySelectorAll("textarea.doc").forEach((el) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  });
}

function markFresh() {
  const seen = new Map();
  for (const c of campaigns()) for (const t of c.tickets) seen.set(`${c.slug}/${t.id}`, t.stage);
  if (previous.size) {
    fresh = new Set();
    for (const [key, stage] of seen) {
      const before = previous.get(key);
      if (before && before !== stage) fresh.add(key.split("/")[1]);
    }
  }
  previous = seen;
  if (fresh.size) {
    setTimeout(() => {
      fresh = new Set();
      if (view === "board") document.querySelectorAll(".strip.fresh").forEach((el) => el.classList.remove("fresh"));
    }, 1400);
  }
}

/* --- drawer --------------------------------------------------------------- */

function openTicket(root, slug, ticketId) {
  const c = campaignOf(root, slug);
  const t = c?.tickets.find((x) => x.id === ticketId);
  if (!c || !t) return;
  drawer = { root, slug, ticket: t.id };
  drawerEl.hidden = false;
  drawerEl.innerHTML = drawerHtml(c, t);
  history.replaceState(null, "", `#ticket/${encodeURIComponent(t.id)}`);
  startLog(c, t);
}

function drawerHtml(c, t) {
  const runs = (c.runs || []).filter((r) => r.ticket === t.id).reverse();
  const latest = runs[0];
  return `<header class="drawer-head">
    <div>
      <h1>${esc(t.id)} · ${esc(t.title)}</h1>
      <p class="meta">${esc(c.slug)} · ${esc(t.kind)} · ${esc(t.stage)}${t.attempts > 1 ? ` · attempt ${t.attempts}` : ""}${t.gateCycles ? ` · ${t.gateCycles} gate cycles` : ""}</p>
    </div>
    <button class="btn ghost" data-act="close-drawer">Close</button>
  </header>
  <div class="drawer-body">
    ${t.queue?.text ? `<p class="meta">${esc(t.queue.text)}</p>` : t.waitingOn ? `<p class="meta">Waiting for a free lane on ${esc(t.waitingOn)}</p>` : ""}
    ${latest ? `<section class="telemetry">
      <h2>Telemetry <span class="hint">${esc(latest.id.replace(/^r-\d{8}T/, ""))} · ${esc(latest.adapter || "?")}${latest.adapterVersion ? ` ${esc(latest.adapterVersion)}` : ""}${latest.host ? ` · ${esc(latest.host)}` : ""}</span></h2>
      <dl>${telemetryOf(latest)
        .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value || "—")}</dd>`)
        .join("")}</dl>
    </section>` : ""}
    ${latest?.children?.length ? `<section class="telemetry children">
      <h2>Child runs <span class="hint">observed only · not tickets · ${num(latest.childTokens || 0)} tokens${latest.childDollars ? ` · ${usd(latest.childDollars)}` : ""}</span></h2>
      <table><thead><tr><th>Child</th><th>Model</th><th>Status</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>
        ${latest.children
          .map(
            (child) => `<tr><td class="mono">${esc(child.name || child.id)}</td><td class="mono">${esc(child.model || "—")}</td><td>${esc(child.status || "—")}</td><td class="num">${num(child.tokens)}</td><td class="num">${child.dollars ? usd(child.dollars) : "—"}</td></tr>`,
          )
          .join("")}
      </tbody></table>
    </section>` : ""}
    <h2>What to build</h2><div class="doc">${esc(t.body || "")}</div>
    <h2>Acceptance</h2><div class="doc">${(t.accepted || []).map((a) => `· ${esc(a.text)}`).join("\n") || "none declared"}</div>
    ${(t.attachments || []).length ? `<h2>Attached files</h2><div class="doc">${(t.attachments || []).map((p) => `· ${esc(p)}`).join("\n")}</div>` : ""}
    ${t.answer ? `<h2>Last answer</h2><div class="doc">${esc(t.answer.text)}${t.answer.citation ? `\n${esc(t.answer.citation)}` : ""}</div>` : ""}
    ${t.findings ? `<h2>Findings</h2><pre class="log">${esc(t.findings)}</pre>` : ""}
    <h2>Runs</h2>
    <table><thead><tr><th>Run</th><th>Role</th><th>Model</th><th>Report</th><th class="num">Cost</th></tr></thead><tbody>
      ${runs
        .map(
          (r) => `<tr><td class="mono" style="font-size:0.76rem" title="${esc(r.id)}">${esc(r.id.replace(/^r-\d{8}T/, ""))}</td><td>${esc(r.role)}</td><td class="mono" style="font-size:0.76rem">${esc(r.model || "")}</td><td>${esc(r.reportStatus || r.status)}${r.killed ? ` (${esc(r.killed)})` : ""}</td><td class="num">${esc(r.cost?.text || (r.unmetered ? "included" : usd(r.dollars)))}</td></tr>`,
        )
        .join("") || `<tr><td colspan="5" class="hint">No runs yet.</td></tr>`}
    </tbody></table>
    <h2>Log${latest ? ` · ${esc(latest.id.replace(/^r-\d{8}T/, ""))}` : ""}</h2>
    <pre class="log" id="log">${latest ? "" : "Nothing has run for this ticket."}</pre>
    ${editBlock(c, t)}
  </div>
  <footer class="drawer-foot">${drawerActions(c, t)}</footer>`;
}

function editBlock(c, t) {
  const attrs = `data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" data-ticket="${esc(t.id)}"`;
  return `<details class="edit-ticket">
    <summary>Edit ticket</summary>
    <div class="field" style="grid-template-columns:5.5rem 1fr"><label>Title</label><input name="e_title" type="text" value="${esc(t.title)}" /></div>
    <div class="field" style="grid-template-columns:5.5rem 1fr"><label>Kind</label>
      <select name="e_kind">${Object.keys(c.effectiveKinds || {}).map((k) => `<option ${k === t.kind ? "selected" : ""}>${esc(k)}</option>`).join("")}</select>
    </div>
    <div class="field" style="grid-template-columns:5.5rem 1fr"><label>Paths</label><input name="e_touches" type="text" value="${esc((t.touches || []).join(", "))}" /></div>
    <div class="field" style="grid-template-columns:5.5rem 1fr"><label>Files</label><input name="e_attachments" type="text" value="${esc((t.attachments || []).join(", "))}" /></div>
    <div class="field" style="grid-template-columns:5.5rem 1fr"><label>Upload</label><input type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" multiple data-role="attach-files" data-target="e_attachments" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" /></div>
    <div class="field" style="grid-template-columns:5.5rem 1fr"><label>Blocked by</label><input name="e_blocked" type="text" value="${esc((t.blockedBy || []).join(", "))}" /></div>
    <div class="field" style="grid-template-columns:5.5rem 1fr"><label>What to build</label><textarea name="e_what" rows="4">${esc(t.body || "")}</textarea></div>
    <div class="field" style="grid-template-columns:5.5rem 1fr"><label>Acceptance</label><textarea name="e_accept" rows="4">${esc((t.accepted || []).map((a) => a.text).join("\n"))}</textarea></div>
    <div class="actions">
      <button class="btn primary" data-act="save-ticket" ${attrs}>Save ticket</button>
      <button class="btn signal" data-act="remove-ticket" ${attrs}>Remove ticket</button>
    </div>
  </details>`;
}

function drawerActions(c, t) {
  const live = Boolean(t.run && t.run.status === "live");
  const attrs = `data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" data-ticket="${esc(t.id)}"`;
  const buttons = [];
  if (live) buttons.push(`<button class="btn signal" data-act="stop" ${attrs}>Stop run</button>`);
  if (["failed", "needs_changes"].includes(t.stage)) buttons.push(`<button class="btn" data-act="retry" ${attrs}>Retry ticket</button>`);
  if (t.stage === "needs_answer") buttons.push(`<button class="btn primary" data-act="open-inbox" ${attrs}>Answer in the inbox</button>`);
  if (!buttons.length) {
    const note = { done: "Landed. Nothing to do here.", dropped: "Dropped: there was no work.", queued: "Queued. The next tick dispatches it.", working: "Running. Watch the log, or stop the run." }[t.stage] || "";
    return `<span class="hint">${esc(note)}</span>`;
  }
  return buttons.join("");
}

function startLog(c, t) {
  clearInterval(logTimer);
  logOffset = 0;
  const latest = (c.runs || []).filter((r) => r.ticket === t.id).slice(-1)[0];
  const pre = document.getElementById("log");
  if (!latest || !pre) return;
  pre.textContent = "";
  let pending = "";
  const pull = async () => {
    try {
      const body = await api(
        `/api/log?project=${encodeURIComponent(c.root)}&campaign=${encodeURIComponent(c.slug)}&run=${encodeURIComponent(latest.id)}&offset=${logOffset}`,
      );
      if (!body.text) return;
      logOffset = body.offset;
      const lines = (pending + body.text).split("\n");
      pending = lines.pop() ?? "";
      pre.textContent += lines
        .map((line) => {
          try {
            const event = JSON.parse(line);
            if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta")
              return event.assistantMessageEvent.delta;
            if (event.type === "tool_execution_start") return `\n→ ${event.toolName || ""}\n`;
            if (event.type === "message_end") return "\n";
            return "";
          } catch {
            return "";
          }
        })
        .join("");
      pre.scrollTop = pre.scrollHeight;
    } catch {
      /* no log yet */
    }
  };
  pull();
  logTimer = setInterval(pull, 2000);
}

function closeDrawer() {
  drawer = null;
  drawerEl.hidden = true;
  clearInterval(logTimer);
  if (location.hash.startsWith("#ticket/")) {
    if (view === "campaign" && selected.campaign) {
      history.replaceState(null, "", `#campaign/${encodeURIComponent(selected.campaign)}`);
    } else {
      syncFleetUrl();
    }
  }
}

function routeFromHash() {
  const raw = location.hash.slice(1);
  const [name, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  if (name.startsWith("campaign/")) {
    const slug = decodeURIComponent(name.slice("campaign/".length));
    const found = campaigns().find((c) => c.slug === slug);
    if (found) selected = { root: found.root, campaign: found.slug };
    view = "campaign";
    render();
    return;
  }
  if (name.startsWith("ticket/")) {
    const id = decodeURIComponent(name.slice("ticket/".length));
    if (current() && id) openTicket(current().root, current().slug, id);
    return;
  }
  if (VIEWS.includes(name)) {
    const nextStatus = FLEET_STATUS.includes(params.get("status")) ? params.get("status") : "all";
    const changed =
      name !== view ||
      nextStatus !== fleetStatus ||
      (params.get("project") || "") !== fleetProject ||
      (params.get("adapter") || "") !== fleetAdapter ||
      (params.get("q") || "") !== fleetQuery;
    view = name;
    fleetStatus = nextStatus;
    fleetProject = params.get("project") || "";
    fleetAdapter = params.get("adapter") || "";
    fleetQuery = params.get("q") || "";
    fleetLimit = 200;
    if (changed) {
      closeDrawer();
      render();
    }
  }
}

/* --- events --------------------------------------------------------------- */

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("could not read the file"));
    reader.readAsDataURL(file);
  });
}

async function uploadAttachments(input) {
  const target = document.querySelector(`[name="${input.dataset.target}"]`);
  if (!target) return;
  const paths = target.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const file of input.files || []) {
    try {
      const data = await readDataUrl(file);
      const res = await fetch("/api/attachments", {
        method: "POST",
        headers: { "content-type": "application/json", "x-orch-token": token },
        body: JSON.stringify({ root: input.dataset.root, campaign: input.dataset.campaign, name: file.name, data }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "upload failed");
      if (!paths.includes(body.path)) paths.push(body.path);
    } catch (err) {
      toast(err.message);
    }
  }
  target.value = paths.join(", ");
  input.value = "";
  toast("image attached");
}

let folderState = { path: null, parent: null };

async function openFolder(path) {
  try {
    const res = await fetch(`/api/browse?path=${encodeURIComponent(path || "")}`, {
      headers: { "x-orch-token": token },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "could not read the folder");
    folderState = { path: body.path, parent: body.parent };
    document.getElementById("folder-picker").hidden = false;
    document.getElementById("browse-path").textContent = body.path;
    document.getElementById("browse-list").innerHTML = body.entries.length
      ? body.entries
          .map(
            (entry) =>
              `<li><button data-act="browse-into" data-path="${esc(entry.path)}">${esc(entry.name)}/</button></li>`,
          )
          .join("")
      : `<li class="model-empty">No subdirectories. Open this folder, or go up.</li>`;
  } catch (err) {
    toast(err.message);
  }
}

async function openSelectedFolder() {
  if (!folderState.path) return toast("Choose a folder first");
  try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-orch-token": token },
      body: JSON.stringify({ root: folderState.path }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "could not open the repository");
    document.getElementById("folder-picker").hidden = true;
    toast("repository opened");
    await load();
    const project = state.projects.find((item) => item.root === body.root);
    const campaign = project?.campaigns?.[0];
    if (campaign) {
      selected = { root: campaign.root, campaign: campaign.slug };
      view = "campaign";
      history.replaceState(null, "", `#campaign/${encodeURIComponent(campaign.slug)}`);
      render();
    }
  } catch (err) {
    toast(err.message);
  }
}

document.addEventListener("click", (event) => {
  if (event.target.id === "folder-picker") event.target.hidden = true;
  if (event.target.id === "dispatch-modal") event.target.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!document.getElementById("folder-picker").hidden) document.getElementById("folder-picker").hidden = true;
  if (!document.getElementById("dispatch-modal").hidden) document.getElementById("dispatch-modal").hidden = true;
});

function openDispatchModal() {
  if (!campaigns().length) return toast("Open a repository before changing dispatch");
  const paused = state?.dispatch?.mode === "paused";
  dispatchModalMode = paused ? "auto" : "paused";
  const modal = document.getElementById("dispatch-modal");
  modal.hidden = false;
  document.getElementById("dispatch-title").textContent = paused ? "Resume dispatch" : "Pause dispatch";
  document.getElementById("dispatch-copy").textContent = paused
    ? "New runs will resume on the next tick. Live runs were never paused."
    : "Pausing stops new dispatches on every project. Live runs keep going.";
  const reason = document.getElementById("dispatch-reason");
  reason.value = paused ? "" : state?.dispatch?.reason || "";
  reason.placeholder = paused ? "optional note" : "quota exhausted, machine busy, a person is reviewing…";
  document.getElementById("dispatch-apply").textContent = paused ? "Resume dispatch" : "Pause dispatch";
  document.getElementById("dispatch-note").textContent = paused
    ? `Paused${state?.dispatch?.at ? ` ${elapsed(state.dispatch.at)} ago` : ""}${state?.dispatch?.by ? ` by ${state.dispatch.by}` : ""}`
    : "A reason is required.";
  reason.focus();
}

function applyDispatchSwitch() {
  const root = campaigns()[0]?.root;
  if (!root) return toast("Open a repository first");
  const reason = document.getElementById("dispatch-reason").value.trim();
  if (dispatchModalMode === "paused" && !reason) return toast("A pause needs a reason");
  document.getElementById("dispatch-modal").hidden = true;
  return command(root, {
    type: dispatchModalMode === "paused" ? "dispatch.pause" : "dispatch.resume",
    reason: reason || null,
    by: "panel",
  });
}

function closeModelSuggest() {
  document.querySelectorAll(".model-suggest").forEach((box) => {
    box.hidden = true;
    box.innerHTML = "";
  });
}

function renderModelSuggest(input) {
  const picker = input.closest(".model-picker");
  const box = picker?.querySelector(".model-suggest");
  if (!box) return;
  const scope = picker.dataset.scope;
  const kind = picker.dataset.kind;
  const q = input.value.trim().toLowerCase();
  const rows = modelOptions(scope, kind).filter((row) => {
    if (!q) return true;
    const adapter = row.adapter || "pi";
    return `${adapter} ${row.provider}/${row.model} ${row.label || ""} ${priceLabel(row)}`.toLowerCase().includes(q);
  });
  const visible = rows.slice(0, 60);
  box.innerHTML = visible.length
    ? visible
        .map((row) => {
          const adapter = row.adapter || "pi";
          const value = `${adapter}|${row.provider}/${row.model}`;
          const label = `${adapter} · ${row.provider}/${row.model} · ${row.context || "?"}${row.images ? " · images" : ""} · ${priceLabel(row)}`;
          return `<button type="button" class="model-option" data-model-option data-adapter="${esc(adapter)}" data-model="${esc(`${row.provider}/${row.model}`)}" data-label="${esc(label)}" data-value="${esc(value)}">${esc(label)}</button>`;
        })
        .join("")
    : `<div class="model-empty">no model matches “${esc(input.value)}”</div>`;
  box.hidden = false;
}

function chooseModelOption(option) {
  const picker = option.closest(".model-picker");
  if (!picker) return;
  picker.querySelector('[data-role="model"]').value = option.dataset.value;
  picker.querySelector('[data-role="model-search"]').value = option.dataset.label;
  closeModelSuggest();
}

document.addEventListener("click", (event) => {
  const option = event.target.closest("[data-model-option]");
  if (option) {
    event.preventDefault();
    chooseModelOption(option);
    return;
  }
  if (!event.target.closest(".model-picker")) closeModelSuggest();
});

document.addEventListener("input", (event) => {
  const input = event.target.closest('[data-role="model-search"]');
  if (!input) return;
  const picker = input.closest(".model-picker");
  picker.querySelector('[data-role="model"]').value = "";
  renderModelSuggest(input);
});

document.addEventListener("focusin", (event) => {
  const input = event.target.closest('[data-role="model-search"]');
  if (input) renderModelSuggest(input);
});

document.addEventListener("keydown", (event) => {
  const input = event.target.closest('[data-role="model-search"]');
  if (!input) return;
  const box = input.closest(".model-picker")?.querySelector(".model-suggest");
  if (event.key === "Escape") {
    closeModelSuggest();
    input.blur();
    return;
  }
  if (event.key === "Enter") {
    const first = box?.querySelector("[data-model-option]");
    if (first && !box.hidden) {
      event.preventDefault();
      chooseModelOption(first);
    }
  }
});

document.addEventListener("change", (event) => {
  const fleetProjectSelect = event.target.closest("[data-role='fleet-project']");
  if (fleetProjectSelect) {
    fleetProject = fleetProjectSelect.value;
    fleetLimit = 200;
    render();
    return syncFleetUrl();
  }
  const fleetAdapterSelect = event.target.closest("[data-role='fleet-adapter']");
  if (fleetAdapterSelect) {
    fleetAdapter = fleetAdapterSelect.value;
    fleetLimit = 200;
    render();
    return syncFleetUrl();
  }
  if (event.target.closest("[data-accept-select]")) return updateBulkBar();
  const files = event.target.closest("input[data-role='attach-files']");
  if (files) {
    uploadAttachments(files);
    return;
  }
  const spend = event.target.closest("select[name='spend']");
  if (spend) {
    spendChoice[view === "campaign" ? "campaign" : "console"] = spend.value;
    render();
    return;
  }
  const select = event.target.closest("select[data-role='adapter']");
  if (!select) return;
  const scope = select.dataset.scope;
  adapterChoice[scope] = select.value;
  spendChoice[scope] = null;
  render();
});

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-act]");
  if (!target) return;
  const { act, root, campaign, item, ticket } = target.dataset;
  const text = item ? document.querySelector(`[data-answer="${item}"]`)?.value || "" : "";
  switch (act) {
    case "go":
      view = target.dataset.view;
      history.replaceState(null, "", `#${view}`);
      return render();
    case "fleet-status":
      fleetStatus = target.dataset.status;
      fleetLimit = 200;
      render();
      return syncFleetUrl();
    case "fleet-more":
      fleetLimit += 200;
      return paintFleet();
    case "open-acceptance":
      view = "acceptance";
      closeDrawer();
      history.replaceState(null, "", "#acceptance");
      return render();
    case "open-campaign": {
      const found = campaignOf(root, campaign);
      if (found) selected = { root: found.root, campaign: found.slug };
      view = "campaign";
      history.replaceState(null, "", `#campaign/${encodeURIComponent(campaign)}`);
      return render();
    }
    case "approve-acceptance": {
      const note = document.querySelector(`[data-accept-note="${item}"]`)?.value || "";
      return command(root, { type: "review.approve", campaign, item, text: note });
    }
    case "reject-acceptance": {
      const note = document.querySelector(`[data-accept-note="${item}"]`)?.value || "";
      if (!note.trim()) return toast("Say what needs to change before sending it back");
      return command(root, { type: "review.reject", campaign, item, text: note });
    }
    case "approve-selected": {
      const picks = [...document.querySelectorAll("[data-accept-select]:checked")];
      if (!picks.length) return toast("Select a delivery first");
      const campaigns = new Set(picks.map((pick) => `${pick.dataset.root}:${pick.dataset.campaign}`));
      if (campaigns.size > 1) return toast("Bulk approval is limited to one campaign");
      const first = picks[0];
      const root = first.dataset.root;
      const campaign = first.dataset.campaign;
      const over = picks.find((pick) => pick.dataset.under !== "true");
      if (over) return toast("This delivery is not eligible for bulk approval; approve it individually");
      return command(root, {
        type: "review.approve-bulk",
        campaign,
        items: picks.map((pick) => pick.dataset.item),
        text: "Approved in bulk from the acceptance queue.",
      });
    }
    case "quota-add": {
      const scope = target.dataset.scope;
      const rows = readQuotaRows(scope);
      rows.push({ provider: "", adapter: "", window: "weekly", used: 0, limit: 100, resetAt: "", source: "manual" });
      quotaDraft[scope] = rows;
      return refreshQuotaEditor(scope);
    }
    case "quota-remove": {
      const scope = target.dataset.scope;
      const rows = readQuotaRows(scope);
      rows.splice(Number(target.dataset.index), 1);
      quotaDraft[scope] = rows;
      return refreshQuotaEditor(scope);
    }
    case "dispatch-open":
      return openDispatchModal();
    case "dispatch-preset":
      document.getElementById("dispatch-reason").value = target.dataset.reason || "";
      return document.getElementById("dispatch-reason").focus();
    case "close-dispatch":
      document.getElementById("dispatch-modal").hidden = true;
      return;
    case "dispatch-apply":
      return applyDispatchSwitch();
    case "select-campaign":
      clearDrafts("campaign");
      adapterChoice.campaign = null;
      spendChoice.campaign = null;
      selected = { root, campaign };
      if (view === "campaign") history.replaceState(null, "", `#campaign/${encodeURIComponent(campaign)}`);
      return render();
    case "open-ticket":
      event.preventDefault();
      return openTicket(root, campaign, ticket);
    case "close-drawer":
      return closeDrawer();
    case "open-inbox":
      view = "inbox";
      history.replaceState(null, "", "#inbox");
      closeDrawer();
      return render();
    case "answer":
      return command(root, { type: "answer", campaign, item, text });
    case "approve-item":
      return command(root, { type: "review.approve", campaign, item, text });
    case "reject-item":
      return command(root, { type: "review.reject", campaign, item, text });
    case "retry":
      return command(root, { type: "retry", campaign, ticket });
    case "stop":
      return command(root, { type: "stop", campaign, ticket });
    case "pause":
      return command(root, { type: "pause", campaign });
    case "resume":
      return command(root, { type: "resume", campaign });
    case "save-ticket": {
      const patch = {
        title: value("e_title"),
        kind: value("e_kind"),
        touches: value("e_touches"),
        attachments: value("e_attachments"),
        blocked_by: value("e_blocked"),
        what: value("e_what"),
        criteria: value("e_accept"),
      };
      closeDrawer();
      return command(root, { type: "ticket.edit", campaign, ticket, patch });
    }
    case "remove-ticket": {
      if (!confirm(`Remove ticket ${ticket}? The ticket file is deleted; its history stays in the ledger.`)) return;
      closeDrawer();
      return command(root, { type: "ticket.remove", campaign, ticket });
    }
    case "cancel-campaign": {
      if (!confirm("Stop every live run and pause this campaign?")) return;
      return command(root, { type: "cancel", campaign });
    }
    case "archive-campaign": {
      if (!confirm("Archive this campaign? It leaves the board; the branches stay.")) return;
      return command(root, { type: "archive", campaign });
    }
    case "promote":
      return command(root, { type: "promote", campaign, id: target.dataset.id });
    case "deliver":
      return command(root, { type: "deliver", campaign });
    case "approve-campaign":
      return command(root, { type: "approve", campaign });
    case "save-campaign":
      return saveCampaign(root, campaign);
    case "save-settings":
      return saveSettings();
    case "refresh-catalog": {
      const root = campaigns()[0]?.root;
      if (!root) return toast("No project registered yet");
      const scope = target.dataset.scope || (view === "campaign" ? "campaign" : "console");
      return command(root, { type: "catalog.refresh", adapter: "all", all: true });
    }
    case "add-ticket":
      return addTicket(root, campaign);
    case "chain-add": {
      const scope = target.dataset.scope;
      const kind = target.dataset.kind;
      const value = document.querySelector(`input[data-role="model"][data-scope="${scope}"][data-kind="${kind}"]`)?.value;
      const thinking = document.querySelector(`select[data-role="thinking"][data-scope="${scope}"][data-kind="${kind}"]`)?.value || "medium";
      if (!value) return toast("Pick a model first");
      const [adapter, ...rest] = value.split("|");
      const model = rest.join("|");
      const list = draft(scope, kind, []);
      if (list.some((m) => m.model === model && m.adapter === adapter)) return toast("Already in the chain");
      list.push({ adapter, model, thinking });
      render();
      return;
    }
    case "chain-remove": {
      const list = draft(target.dataset.scope, target.dataset.kind, []);
      list.splice(Number(target.dataset.index), 1);
      render();
      return;
    }
    case "chain-cheapest": {
      const scope = target.dataset.scope;
      const kind = target.dataset.kind;
      const first = modelOptions(scope, kind)[0];
      if (!first) return toast("No model catalog for this adapter");
      const adapter = first.adapter || "pi";
      const model = `${first.provider}/${first.model}`;
      const list = draft(scope, kind, []);
      if (list.some((entry) => entry.model === model && entry.adapter === adapter)) return toast("Already in the chain");
      const thinking = document.querySelector(`select[data-role="thinking"][data-scope="${scope}"][data-kind="${kind}"]`)?.value || "medium";
      list.push({ adapter, model, thinking });
      render();
      return;
    }
    case "theme":
      localStorage.setItem("orch.theme", target.dataset.theme);
      document.documentElement.dataset.theme = target.dataset.theme;
      render();
      return;
    case "text-size":
      localStorage.setItem("orch.textSize", target.dataset.size);
      document.documentElement.style.fontSize = `${target.dataset.size}px`;
      render();
      return;
    case "browse-repo":
      return openFolder(null);
    case "browse-into":
      return openFolder(target.dataset.path);
    case "browse-parent":
      return openFolder(folderState.parent);
    case "browse-open":
      return openSelectedFolder();
    case "close-folder":
      document.getElementById("folder-picker").hidden = true;
      return;
    case "new-campaign":
      app.innerHTML = newCampaignForm();
      return autoSize();
    case "create-campaign":
      return createCampaign();
  }
});

tabsEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (!button) return;
  view = button.dataset.view;
  closeDrawer();
  render();
  syncFleetUrl();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
  const stripEl = event.target.closest?.(".strip");
  if (stripEl && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openTicket(stripEl.dataset.root, stripEl.dataset.campaign, stripEl.dataset.ticket);
  }
  const fleetRow = event.target.closest?.(".fleet-row");
  if (fleetRow && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    if (fleetRow.dataset.act === "open-acceptance") {
      view = "acceptance";
      closeDrawer();
      history.replaceState(null, "", "#acceptance");
      render();
    } else {
      openTicket(fleetRow.dataset.root, fleetRow.dataset.campaign, fleetRow.dataset.ticket);
    }
  }
});

document.addEventListener("input", (event) => {
  const search = event.target.closest("[data-role='fleet-search']");
  if (search) {
    fleetQuery = search.value;
    fleetLimit = 200;
    paintFleet();
    return;
  }
  if (event.target.matches("textarea.doc")) {
    event.target.style.height = "auto";
    event.target.style.height = `${event.target.scrollHeight + 2}px`;
  }
});

window.addEventListener("hashchange", routeFromHash);

function connect() {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}&lastId=0`);
  source.onopen = () => {
    connEl.className = "dot live";
    connText.textContent = "live";
  };
  source.onmessage = () => scheduleLoad();
  source.onerror = () => {
    connEl.className = "dot dead";
    connText.textContent = "reconnecting";
  };
}

if (!token) {
  app.innerHTML = `<div class="empty"><h2>Token required</h2><p>Open the URL printed by <span class="mono">orchestrate run</span> or <span class="mono">orchestrate panel</span>. It carries the token this page needs.</p></div>`;
} else {
  load().then(routeFromHash);
  connect();
  setInterval(() => load({ quiet: true }), 15000);
  clock = setInterval(() => {
    document.querySelectorAll(".elapsed").forEach((el) => {
      el.textContent = elapsed(el.dataset.since);
    });
  }, 1000);
}
