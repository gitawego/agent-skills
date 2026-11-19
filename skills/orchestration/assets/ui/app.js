/* Orchestration panel. No framework, no build step: state in, DOM out. */

const VIEWS = ["fleet", "sessions", "leader", "inbox", "acceptance", "settings"];
const CAMPAIGN_TABS = ["overview", "tickets", "sessions", "configure", "history"];
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

const KANBAN_LANES = [
  { id: "queued", label: "Queued", stages: ["blocked", "queued"], family: "idle", empty: "Nothing queued" },
  { id: "working", label: "Working", stages: ["working"], family: "active", empty: "No run in flight" },
  { id: "attention", label: "Needs you", stages: ["needs_answer", "needs_changes", "failed"], family: "person", empty: "Nothing needs you" },
  { id: "done", label: "Done", stages: ["done", "dropped"], family: "done", empty: "Nothing landed yet" },
];

const params = new URLSearchParams(location.search);
const API_BASE = window.__ORCH_API_BASE__ || location.origin;
let token = window.__ORCH_TOKEN__ || params.get("token") || localStorage.getItem("orch.token") || "";
if (params.get("token")) {
  try {
    localStorage.setItem("orch.token", token);
  } catch {
    /* storage can be blocked; the server sets an HttpOnly cookie either way */
  }
  history.replaceState(null, "", location.pathname + location.hash);
}

const storedTextSize = Number(localStorage.getItem("orch.textSize") || 0);
/* 15px was the old minimum and reads too small on high-DPI screens. */
const textSize = storedTextSize === 15 ? 18 : storedTextSize || 18;
if (storedTextSize === 15) {
  try {
    localStorage.setItem("orch.textSize", "18");
  } catch {
    /* storage can be blocked */
  }
}
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
const initialPath = initialHash.name.startsWith("campaign/")
  ? decodeURIComponent(initialHash.name.slice("campaign/".length)).split("/")
  : null;
let view = VIEWS.includes(initialHash.name) ? initialHash.name : initialPath ? "campaign" : "fleet";
let campaignTab = initialPath && CAMPAIGN_TABS.includes(initialPath[1]) ? initialPath[1] : "overview";
let ticketView = "list";
let ticketKind = "all";
let ticketQuery = "";
let fleetStatus = FLEET_STATUS.includes(initialHash.params.get("status")) ? initialHash.params.get("status") : "all";
let fleetProject = initialHash.params.get("project") || "";
let fleetAdapter = initialHash.params.get("adapter") || "";
let fleetQuery = initialHash.params.get("q") || "";
let initialCampaign = initialHash.params.get("campaign") || (initialPath ? initialPath[0] : null);
let fleetLimit = 200;
let dispatchModalMode = "paused";
let quotaDraft = {};
let selected = { root: null, campaign: initialCampaign };
let drawer = null;
let logTimer = null;
let logOffset = 0;
let refreshTimer = null;
let previous = new Map();
let fresh = new Set();
let clock = null;
let sessionTicket = null;
let sessionTerm = null;
let sessionFit = null;
let sessionSocket = null;
let sessionStatus = null;
let sessionTranscriptKey = null;
let sessionTranscriptData = null;
let sessionTermKey = null;
let sessionTermMode = null;
let sessionTakeoverTimer = null;
let sessionAppId = null;
let sessionAppCleanup = [];
let terminalStatusId = "terminal-status";
let acpPermissionTimer = null;
let leaderRoot = null;
let paletteRows = [];
let paletteIndex = 0;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
let drafts = {};
let dirtyViews = new Set();
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
const sessionCount = document.getElementById("session-count");
const dispatchPill = document.getElementById("dispatch-pill");
const signalEl = document.getElementById("signal");
const footState = document.getElementById("foot-state");
const scopeLabel = document.getElementById("scope-label");
const scopeMeta = document.getElementById("scope-meta");
const campaignCount = document.getElementById("campaign-count");
const statusRuntime = document.getElementById("status-runtime");
const paletteEl = document.getElementById("palette");
const paletteInput = document.getElementById("palette-input");
const paletteResultsEl = document.getElementById("palette-results");

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
  const url = new URL(path, API_BASE);
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

function copyFallback(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
    toast("Copied");
  } catch {
    window.prompt("Copy this command", text);
  }
  area.remove();
}

function copyText(text, message = "Copied") {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(message), () => copyFallback(text));
  } else {
    copyFallback(text);
  }
}

function formBusy() {
  if (document.querySelector(".model-suggest:not([hidden])")) return true;
  const active = document.activeElement;
  if (!active || !active.closest?.("#app")) return false;
  if (active.closest(".model-picker")) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
}

/* The surface is what the person is actually editing, not just the nav tab. */
function surface() {
  return view;
}

/* A background poll may update chrome, but it must never replace a form,
   a typed value, an open ticket form or an acceptance selection. */
function pageBusy() {
  if (formBusy()) return true;
  if (dirtyViews.has(surface())) return true;
  if (document.querySelector("#app details[open]")) return true;
  return false;
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
       control, a typed value or an open form. Update the chrome
       (counts, rail, dispatch pill) and leave the working surface alone. */
    if (pageBusy()) {
      renderChrome();
      return;
    }
    render({ preserveScroll: true });
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

function targetCampaigns() {
  if (selected.campaign) {
    const list = campaigns().filter((c) => c.slug === selected.campaign && (!selected.root || c.root === selected.root));
    if (list.length) return list;
  }
  return campaigns();
}

function allOpenItems() {
  return targetCampaigns().flatMap((c) => (c.inbox || []).filter((i) => i.status === "open").map((item) => ({ ...item, campaign: c })));
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
  for (const c of targetCampaigns()) {
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
  if (run.context) {
    rows.push([
      "Prompt",
      `${num(run.context.promptTokensEstimate || 0)} tok est · ${num(run.context.dependencyChars || 0)} B dependencies · ${num(run.context.decisionChars || 0)} B decisions`,
    ]);
  }
  rows.push(["Cost", costText(run.cost)]);
  return rows;
}

function ensureSelection() {
  const all = campaigns();
  if (!all.length) {
    selected = { root: null, campaign: null };
    return;
  }
  if (!selected.campaign) {
    if (view === "campaign") {
      selected = { root: all[0].root, campaign: all[0].slug };
    }
    return;
  }
  const found = all.find((c) => (!selected.root || c.root === selected.root) && c.slug === selected.campaign);
  if (!found) {
    selected = view === "campaign" ? { root: all[0].root, campaign: all[0].slug } : { root: null, campaign: null };
  }
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

function acpPermissionFor(scope) {
  return (scope === "console" ? state?.console?.runner?.acpPermission : current()?.runner?.acpPermission) || "auto";
}

function acpPermissionSelect(scope) {
  const chosen = acpPermissionFor(scope);
  return `<select name="acp_permission" aria-label="${scope} ACP permissions">
    <option value="auto" ${chosen === "auto" ? "selected" : ""}>auto-approve inside the worktree</option>
    <option value="ask" ${chosen === "ask" ? "selected" : ""}>ask in Sessions</option>
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
  const allList = campaigns();
  const projects = [...new Map(allList.map((c) => [c.project, c.root])).entries()];
  const adapters = [...new Set(fleetRows().map((row) => row.adapter).filter(Boolean))].sort();
  return `<div class="fleet-filters">
    <input type="search" data-role="fleet-search" value="${esc(fleetQuery)}" placeholder="Search task, project, model, queue reason…" aria-label="Search the fleet" autocomplete="off" spellcheck="false" />
    <select data-role="fleet-campaign" aria-label="Filter by campaign">
      <option value="">all campaigns</option>
      ${allList.map((c) => `<option value="${esc(c.slug)}" data-root="${esc(c.root)}" ${selected.campaign === c.slug && (!selected.root || selected.root === c.root) ? "selected" : ""}>${esc(c.slug)}</option>`).join("")}
    </select>
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
  const scopeTitle = selected.campaign ? ` <span class="hint">· ${esc(selected.campaign)}</span>` : "";
  const lede = selected.campaign
    ? `Tickets in <b>${esc(selected.campaign)}</b>, with why they are or are not moving. Click a row to open the ticket; acceptance rows open the delivery.`
    : "Every ticket across every project, with why it is or is not moving. Click a row to open the ticket; acceptance rows open the delivery.";
  return `<h1 class="page">Fleet${scopeTitle}</h1>
    <p class="lede">${lede}</p>
    <div class="actions">${openCampaignButton()}</div>
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
  /* the initial load renders Fleet before routeFromHash can translate an old
     #campaign or #board link; do not overwrite the address it needs */
  if (/^#(campaign|board)(\?|$)/.test(location.hash) || location.hash.startsWith("#ticket/")) return;
  if (view === "campaign" && selected.campaign) {
    history.replaceState(null, "", `#campaign/${encodeURIComponent(selected.campaign)}/${campaignTab}`);
    return;
  }
  const params = new URLSearchParams();
  if (fleetStatus !== "all") params.set("status", fleetStatus);
  if (fleetProject) params.set("project", fleetProject);
  if (fleetAdapter) params.set("adapter", fleetAdapter);
  if (fleetQuery.trim()) params.set("q", fleetQuery.trim());
  if (selected.campaign) params.set("campaign", selected.campaign);
  const query = params.toString();
  const hash = view === "fleet" ? `#fleet${query ? `?${query}` : ""}` : `#${view}${selected.campaign ? `?campaign=${encodeURIComponent(selected.campaign)}` : ""}`;
  history.replaceState(null, "", hash);
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
          const rule = !stats
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
                (item) => `<article class="acceptance-card handoff" data-root="${esc(campaign.root)}" data-campaign="${esc(campaign.slug)}" data-item="${esc(item.id)}">
                  <header>
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
                  ${commandRow("Approve in your agent", `orchestrate review ${item.id} approve "…"`)}
                  ${commandRow("Send back in your agent", `orchestrate review ${item.id} reject "…"`)}
                  <div class="actions">
                    <button class="btn primary" data-act="approve-item" data-cleanup="true" data-root="${esc(campaign.root)}" data-campaign="${esc(campaign.slug)}" data-item="${esc(item.id)}">Approve, merge and clean up</button>
                    <button class="btn ghost" data-act="open-campaign" data-root="${esc(campaign.root)}" data-campaign="${esc(campaign.slug)}">Open campaign</button>
                  </div>
                </article>`,
              )
              .join("")}
          </section>`;
        })
        .join("")
    : `<div class="empty"><h2>Nothing is waiting for acceptance.</h2><p>Deliveries appear here when a campaign passes its gates and its landing policy needs a person. Review them in your agent session.</p><button class="btn" data-act="go" data-view="fleet">Back to the fleet</button></div>`;
  const countLabel = items.length ? ` · ${items.length} waiting` : "";
  const scopeLabel = selected.campaign ? ` <span class="hint">· ${esc(selected.campaign)}</span>` : "";
  return `<h1 class="page">Acceptance${scopeLabel}${countLabel}</h1>
    <p class="lede">The panel shows the evidence. Approve or send back in your agent session; this queue clears on the next tick.</p>
    <div class="actions">${openCampaignButton()}</div>
    ${body}`;
}

/* --- render --------------------------------------------------------------- */

function goView(name) {
  dirtyViews.clear();
  view = name;
  closeDrawer();
  render();
  syncFleetUrl();
}

function openCampaign(campaign) {
  selected = { root: campaign.root, campaign: campaign.slug };
  view = "campaign";
  campaignTab = "overview";
  dirtyViews.clear();
  closeDrawer();
  history.replaceState(null, "", `#campaign/${encodeURIComponent(campaign.slug)}/overview`);
  render();
}

const PALETTE_ICONS = {
  fleet: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></svg>',
  inbox: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.5h3l1.2 1.8h2.6l1.2-1.8h3" /><path d="M3.4 3.5h9.2l1 5v4H2.4v-4Z" /></svg>',
  acceptance: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="m5.6 8.2 1.7 1.7 3.2-3.5" /></svg>',
  leader: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="m5 6 2 2-2 2M8.5 10h2.5" /></svg>',
  sessions: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10v7H7l-3 2.5v-2.5H3Z" /><path d="M5.5 6h5M5.5 8.2h3.5" /></svg>',
  settings: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5h11M2.5 11h11" /><circle cx="6" cy="5" r="1.6" /><circle cx="10.5" cy="11" r="1.6" /></svg>',
  plus: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>',
  play: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5 12 8l-7 4.5Z" /></svg>',
  pause: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4v8M10 4v8" /></svg>',
  theme: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6" /></svg>',
  campaign: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10v9H3Z" /><path d="M5 6h6M5 8.5h6M5 11h3" /></svg>',
};

function paletteIcon(name) {
  return PALETTE_ICONS[name] || PALETTE_ICONS.campaign;
}

function paletteActions() {
  const dispatch = state?.dispatch || { mode: "auto" };
  const paused = dispatch.mode === "paused";
  const actions = [
    { id: "view:fleet", group: "Go to", label: "Fleet", hint: `${fleetRows().length} rows`, icon: "fleet", run: () => goView("fleet") },
    { id: "view:inbox", group: "Go to", label: "Inbox", hint: `${openItems().length} open`, icon: "inbox", run: () => goView("inbox") },
    { id: "view:acceptance", group: "Go to", label: "Acceptance", hint: `${acceptanceItems().length} waiting`, icon: "acceptance", run: () => goView("acceptance") },
    { id: "view:sessions", group: "Go to", label: "Worker sessions", hint: `${allSessionRows().length} sessions`, icon: "sessions", keywords: "workers sessions leader chat pi", run: () => goView("sessions") },
  ];
  if (window.__ORCH_APP__) {
    actions.push({ id: "view:leader", group: "Go to", label: "Leader", hint: "pi with the orchestration skill", icon: "leader", run: () => goView("leader") });
  }
  actions.push({ id: "view:settings", group: "Go to", label: "Settings", hint: "Console defaults", icon: "settings", run: () => goView("settings") });
  actions.push(
    { id: "action:repo", group: "Actions", label: "Open repository…", hint: "Add a project", icon: "plus", run: () => openFolder(null) },
    { id: "action:start", group: "Actions", label: "Copy start command", hint: 'orchestrate start "<goal>"', icon: "play", run: () => copyText('orchestrate start "<goal>"', "Copied. Paste it in the Leader terminal.") },
    { id: "action:dispatch", group: "Actions", label: paused ? "Resume dispatch" : "Pause dispatch", hint: paused ? dispatch.reason || "paused" : "new runs stop; live runs continue", icon: "pause", run: () => openDispatchModal() },
    {
      id: "action:theme",
      group: "Actions",
      label: `Switch to ${document.documentElement.dataset.theme === "light" ? "dark" : "light"} theme`,
      hint: "Appearance",
      icon: "theme",
      run: () => {
        const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
        localStorage.setItem("orch.theme", next);
        document.documentElement.dataset.theme = next;
        render();
      },
    },
  );
  for (const campaign of campaigns()) {
    actions.push({
      id: `campaign:${campaign.root}:${campaign.slug}`,
      group: "Campaigns",
      label: campaign.slug,
      hint: `${campaign.project} · ${campaign.stage}`,
      icon: "campaign",
      run: () => openCampaign(campaign),
    });
  }
  return actions;
}

function filteredPalette() {
  const query = (paletteInput?.value || "").trim().toLowerCase();
  const actions = paletteActions();
  if (!query) return actions;
  const tokens = query.split(/\s+/).filter(Boolean);
  return actions.filter((action) => {
    const haystack = `${action.label} ${action.hint} ${action.group} ${action.keywords || ""}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function renderPalette() {
  if (!paletteResultsEl) return;
  paletteRows = filteredPalette();
  if (paletteIndex >= paletteRows.length) paletteIndex = 0;
  if (paletteIndex < 0) paletteIndex = 0;
  if (!paletteRows.length) {
    paletteResultsEl.innerHTML = `<div class="palette-empty">No matches. Try “fleet”, “inbox” or a campaign name.</div>`;
    return;
  }
  let html = "";
  let group = "";
  paletteRows.forEach((action, index) => {
    if (action.group !== group) {
      group = action.group;
      html += `<div class="palette-group">${esc(group)}</div>`;
    }
    html += `<button class="palette-item${index === paletteIndex ? " active" : ""}" data-palette-index="${index}">
      <span class="p-icon">${paletteIcon(action.icon)}</span>
      <span class="p-label">${esc(action.label)}</span>
      <span class="p-hint">${esc(action.hint || "")}</span>
    </button>`;
  });
  paletteResultsEl.innerHTML = html;
  const active = paletteResultsEl.querySelector(".palette-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function openPalette() {
  if (!paletteEl) return;
  paletteEl.hidden = false;
  paletteIndex = 0;
  if (paletteInput) paletteInput.value = "";
  renderPalette();
  setTimeout(() => paletteInput?.focus(), 0);
}

function closePalette() {
  if (!paletteEl) return;
  paletteEl.hidden = true;
  paletteRows = [];
}

function runPalette(index) {
  const action = paletteRows[index];
  if (!action) return;
  closePalette();
  action.run();
}

function renderChrome() {
  ensureSelection();
  for (const key of [...dirtyViews]) if (key !== surface()) dirtyViews.delete(key);
  const items = openItems();
  const acceptance = acceptanceItems();
  tabCount.textContent = items.length ? String(items.length) : "";
  acceptCount.textContent = acceptance.length ? String(acceptance.length) : "";
  signalEl.classList.toggle("alert", items.length + acceptance.length > 0);
  footState.textContent = state ? `${campaigns().length} campaign${campaigns().length === 1 ? "" : "s"} · ${state.projects.length} project${state.projects.length === 1 ? "" : "s"}` : "local";
  if (sessionCount) sessionCount.textContent = String(campaigns().reduce((total, campaign) => total + sessionTickets(campaign).length, 0));
  const scope = current();
  if (scopeLabel) scopeLabel.textContent = selected.campaign ? selected.campaign : "All campaigns";
  if (scopeMeta) scopeMeta.textContent = selected.campaign ? `${scope?.project || "campaign"} · ${scope?.stage || "—"}` : `${campaigns().length} campaign${campaigns().length === 1 ? "" : "s"}`;
  if (campaignCount) campaignCount.textContent = String(campaigns().length);
  if (statusRuntime) statusRuntime.textContent = runtimeLabel();
  const theme = document.documentElement.dataset.theme || "dark";
  document.querySelectorAll("[data-act='theme']").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.theme === theme));
  });
  const themeToggle = document.querySelector("[data-act='theme-toggle']");
  if (themeToggle) {
    const next = theme === "light" ? "dark" : "light";
    themeToggle.title = `Switch to ${next} theme`;
    themeToggle.setAttribute("aria-label", `Switch to ${next} theme`);
  }
  const size = Number(localStorage.getItem("orch.textSize") || 18);
  document.querySelectorAll("[data-act='text-size']").forEach((b) => {
    b.setAttribute("aria-pressed", String(Number(b.dataset.size) === size));
  });
  renderDispatch();
  renderRail();
  renderCrumbs();
  renderTabs();
}

function render({ preserveScroll = false } = {}) {
  if (sessionTermMode !== "leader" && sessionTerm && selected.root && selected.campaign && sessionTermKey && !sessionTermKey.startsWith(`${selected.root}|${selected.campaign}/`)) {
    disposeTerminal();
  }
  const terminalView = (view === "campaign" && campaignTab === "sessions") || view === "leader";
  if (!terminalView) {
    stopAcpPolling();
    if (sessionTerm || sessionSocket) disposeTerminal();
    sessionStatus = null;
    sessionTranscriptKey = null;
    sessionTranscriptData = null;
  }
  const viewEl = document.getElementById("app");
  const scroll = preserveScroll ? viewEl?.scrollTop || 0 : 0;
  const fleetScroll = preserveScroll ? document.querySelector(".fleet-wrap")?.scrollLeft || 0 : 0;
  renderChrome();
  if (!state) return;
  if (view === "campaign" && campaignTab === "sessions" && sessionTerm) {
    refreshSessionStatus();
    return;
  }
  if (view === "leader" && sessionTerm) return;
  if (view === "fleet") {
    app.innerHTML = viewFleet();
    paintFleet();
  } else if (view === "leader") app.innerHTML = viewLeader();
  else if (view === "sessions") app.innerHTML = viewSessions();
  else if (view === "inbox") app.innerHTML = viewInbox(openItems());
  else if (view === "campaign") app.innerHTML = viewCampaign();
  else if (view === "acceptance") app.innerHTML = viewAcceptance(acceptanceItems());
  else if (view === "settings") app.innerHTML = viewSettings();

  if (view === "campaign" && campaignTab === "sessions") setTimeout(mountSessions, 0);
  if (view === "leader") setTimeout(mountLeader, 0);
  markFresh();
  if (preserveScroll) {
    if (viewEl) viewEl.scrollTop = scroll;
    const wrap = document.querySelector(".fleet-wrap");
    if (wrap) wrap.scrollLeft = fleetScroll;
  }
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

function runtimeLabel() {
  const runtime = window.__ORCH_RUNTIME__;
  if (!runtime) return "web panel";
  const pi = runtime.pi_version ? `pi ${runtime.pi_version}` : "pi";
  return `${pi} · bun ${runtime.bun_version || "?"}`;
}

function renderRail() {
  const allList = campaigns();
  const totalTickets = allList.reduce((acc, c) => acc + (c.tickets?.length || 0), 0);
  const totalOpen = allList.reduce((acc, c) => acc + (c.tickets || []).filter((t) => t.stage === "working").length, 0);
  const totalWaiting = allList.reduce((acc, c) => acc + (c.inbox || []).filter((i) => i.status === "open").length, 0);
  const allLabel = `${totalTickets} tickets${totalOpen ? ` · ${totalOpen} running` : ""}${totalWaiting ? ` · ${totalWaiting} waiting` : ""}`;
  const isAll = !selected.campaign;
  if (campaignCount) campaignCount.textContent = String(allList.length);

  if (!allList.length) {
    campaignsEl.innerHTML = `<div class="hint" style="padding:6px">No campaigns yet.</div>`;
    return;
  }

  const groups = new Map();
  for (const campaign of allList) {
    const key = campaign.project || campaign.root;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(campaign);
  }

  const campaignRow = (c) => {
    const open = (c.tickets || []).filter((t) => t.stage === "working").length;
    const waiting = (c.inbox || []).filter((i) => i.status === "open").length;
    const draftCount = c.draft?.tickets || 0;
    const label = `${c.tickets.length} tickets${draftCount ? ` · ${draftCount} draft` : ""}${open ? ` · ${open} running` : ""}${waiting ? ` · ${waiting} waiting` : ""}`;
    const isCur = Boolean(selected.campaign && (!selected.root || c.root === selected.root) && c.slug === selected.campaign);
    return `<button class="campaign-row" data-stage="${esc(c.stage)}" data-act="select-campaign" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" aria-current="${isCur}" title="${esc(label)}">
      <span class="campaign-dot" aria-hidden="true"></span>
      <span class="name">${esc(c.slug)}</span>
      <span class="state">${esc(c.stage)}${c.nextAction?.actor === "you" ? " · you" : ""}</span>
      <span class="sub">${esc(label)}</span>
    </button>`;
  };

  const allButton = `<button class="campaign-row campaign-all" data-stage="" data-act="select-campaign" data-root="" data-campaign="" aria-current="${isAll}" title="${esc(allLabel)}">
    <span class="campaign-dot" aria-hidden="true"></span>
    <span class="name">All campaigns</span>
    <span class="state">${allList.length}</span>
    <span class="sub">${esc(allLabel)}</span>
  </button>`;

  const projectGroups = [...groups.entries()]
    .map(
      ([project, list]) => `<div class="campaign-group">
        <div class="campaign-group-head"><span>${esc(project)}</span><span>${list.length}</span></div>
        ${list.map(campaignRow).join("")}
      </div>`,
    )
    .join("");

  campaignsEl.innerHTML = `${allButton}${projectGroups}`;
}

function renderCrumbs() {
  if (view === "fleet") {
    if (selected.campaign) {
      crumbsEl.innerHTML = `<b>Fleet</b><span>·</span><b>${esc(selected.campaign)}</b><span>·</span>${fleetRows().length} row${fleetRows().length === 1 ? "" : "s"}`;
    } else {
      crumbsEl.innerHTML = `<b>Fleet</b><span>·</span>${campaigns().length} campaign${campaigns().length === 1 ? "" : "s"}<span>·</span>${fleetRows().length} rows`;
    }
    return;
  }
  if (view === "inbox") {
    const scope = selected.campaign ? `<b>${esc(selected.campaign)}</b><span>·</span>` : "";
    crumbsEl.innerHTML = `<b>Inbox</b><span>·</span>${scope}${openItems().length} open`;
    return;
  }
  if (view === "acceptance") {
    const scope = selected.campaign ? `<b>${esc(selected.campaign)}</b><span>·</span>` : "";
    crumbsEl.innerHTML = `<b>Acceptance</b><span>·</span>${scope}${acceptanceItems().length} waiting`;
    return;
  }
  if (view === "settings") {
    crumbsEl.innerHTML = `<b>Console</b><span>·</span>this machine`;
    return;
  }
  if (view === "sessions") {
    const rows = allSessionRows();
    crumbsEl.innerHTML = `<b>Sessions</b><span>·</span>${rows.length} worker session${rows.length === 1 ? "" : "s"}<span>·</span>Leader chat`;
    return;
  }
  if (view === "leader") {
    const projects = leaderProjects();
    crumbsEl.innerHTML = `<b>Leader</b><span>·</span>${projects.length} project${projects.length === 1 ? "" : "s"}<span>·</span>pi with the orchestration skill`;
    return;
  }
  const c = current();
  if (!c) {
    crumbsEl.innerHTML = `<span>no campaign</span>`;
    return;
  }
  const parts = [];
  if (c.project && c.project !== c.slug) parts.push(esc(c.project));
  const tabLabel = campaignTab ? campaignTab[0].toUpperCase() + campaignTab.slice(1) : "";
  parts.push(`<b>${esc(c.slug)}</b>`, esc(c.stage), esc(tabLabel));
  crumbsEl.innerHTML = parts.join("<span>·</span>");
}

function renderTabs() {
  const leaderTab = tabsEl.querySelector('button[data-view="leader"]');
  if (leaderTab) leaderTab.hidden = !window.__ORCH_APP__;
  tabsEl.querySelectorAll("button[data-view]").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.view === view));
  });
}

function viewInbox(items) {
  const failed = targetCampaigns().flatMap((c) => (c.planErrors || []).map((e) => `${c.slug}: ${e}`));
  const body = items.length
    ? items.map(itemRow).join("")
    : `<div class="empty">
        <h2>Nothing needs you.</h2>
        <p>${selected.campaign ? `<b>${esc(selected.campaign)}</b> is running on its own.` : "Every campaign is running on its own."} The Fleet shows what is moving.</p>
        <dl class="legend">
          <dt>Question</dt><dd>A worker needs a decision no written source answers.</dd>
          <dt>Failure</dt><dd>Attempts ran out, or a merge would not resolve.</dd>
          <dt>Delivery</dt><dd>Deliveries wait in the Acceptance queue, not here.</dd>
        </dl>
        <button class="btn" data-act="go" data-view="fleet">Back to the fleet</button>
      </div>`;
  const countLabel = items.length ? ` · ${items.length} open` : "";
  const scopeLabel = selected.campaign ? ` <span class="hint">· ${esc(selected.campaign)}</span>` : "";
  return `${failed.length ? `<div class="errors"><strong>Plan problems</strong><ul>${failed.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
    <h1 class="page">Inbox${scopeLabel}${countLabel}</h1>
    <div class="actions">${openCampaignButton()}</div>
    ${body}`;
}

function itemRow(item) {
  const c = item.campaign;
  const ticket = item.ticket ? c.tickets.find((t) => t.id === item.ticket) : null;
  const attrs = `data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" data-item="${esc(item.id)}" data-ticket="${esc(item.ticket || "")}"`;
  const command =
    item.kind === "review"
      ? `orchestrate review ${item.id} approve "…"`
      : item.kind === "failure"
        ? item.ticket
          ? `orchestrate retry ${item.ticket}`
          : "orchestrate inbox"
        : `orchestrate answer ${item.id} "…"`;
  return `<article class="item handoff" data-kind="${esc(item.kind)}">
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
    ${commandRow(item.kind === "review" ? "Review in your agent" : "Answer in your agent", command)}
    ${ticket ? `<div class="actions"><button class="btn ghost" data-act="open-ticket" ${attrs}>Open ticket</button></div>` : ""}
  </article>`;
}

function campaignControls(c) {
  const attrs = `data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}"`;
  const buttons = [];
  if (c.stage === "running") {
    buttons.push(`<button class="btn" data-act="pause" ${attrs}>Pause</button>`);
    buttons.push(`<button class="btn signal" data-act="cancel-campaign" ${attrs}>Cancel all</button>`);
  }
  if (c.stage === "paused") {
    buttons.push(`<button class="btn primary" data-act="resume" ${attrs}>Resume</button>`);
    if (c.delivery?.mode === "manual") buttons.push(`<button class="btn" data-act="deliver" ${attrs}>Deliver</button>`);
    buttons.push(`<button class="btn" data-act="archive-campaign" ${attrs}>Archive</button>`);
  }
  if (c.stage === "delivered") buttons.push(`<button class="btn" data-act="archive-campaign" ${attrs}>Archive</button>`);
  return buttons.join("");
}

function commandRow(label, command) {
  if (!command) return "";
  return `<div class="command-row"><span class="command-label">${esc(label)}</span><code>${esc(command)}</code><button class="btn ghost" data-act="copy" data-command="${esc(command)}" aria-label="Copy command">Copy</button></div>`;
}

function openCampaignButton() {
  if (!selected.campaign) return "";
  const c = campaignOf(selected.root, selected.campaign);
  if (!c) return "";
  return `<button class="btn" data-act="open-campaign" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}">Open campaign</button>`;
}

function nextActionBlock(c) {
  const action = c.nextAction || { actor: "none", text: "", command: null };
  const label = { you: "You", supervisor: "Supervisor", worker: "Worker", none: "Closed" }[action.actor] || action.actor;
  const approve = c.draft?.clean || (c.stage === "awaiting_approval" && !c.draft?.exists && !(c.planErrors || []).length);
  return `<section class="next-action" data-actor="${esc(action.actor)}">
    <span class="actor">${esc(label)}</span>
    <span class="text">${esc(action.text)}</span>
    ${action.command ? `<code>${esc(action.command)}</code><button class="btn ghost" data-act="copy" data-command="${esc(action.command)}" aria-label="Copy next command">Copy</button>` : ""}
    ${approve ? `<button class="btn primary" data-act="approve-campaign" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}">${c.draft?.exists ? "Approve and run" : "Approve"}</button>` : ""}
  </section>`;
}

function campaignSubnav(c) {
  const items = [
    ["overview", "Overview"],
    ["tickets", `Tickets ${c.tickets.length}${c.draft?.tickets ? ` · ${c.draft.tickets} draft` : ""}`],
    ["sessions", "Sessions"],
    ["configure", "Configure"],
    ["history", "History"],
  ];
  return `<nav class="campaign-subnav" aria-label="Campaign sections">${items
    .map(
      ([id, label]) =>
        `<button data-act="campaign-tab" data-tab="${id}" aria-current="${campaignTab === id}">${esc(label)}</button>`,
    )
    .join("")}</nav>`;
}

function campaignHeader(c) {
  const cap = Math.max(1, state?.console?.limits?.max_concurrent || 4);
  const slots = c.tickets.filter((t) => t.stage === "working").length;
  const meter = Array.from({ length: cap }, (_, i) => `<i class="${i < slots ? "on" : ""}"></i>`).join("");
  const goal = (c.goal || "").trim();
  const reviewed = c.tickets.filter((ticket) => ticket.reviewedHead);
  const reviewedChip = reviewed.length
    ? `<span class="quality-chip" title="${esc(reviewed.map((ticket) => `${ticket.id}@${ticket.reviewedHead}`).join(", "))}">reviewed ${esc(reviewed[reviewed.length - 1].reviewedHead.slice(0, 8))}${reviewed.length > 1 ? ` +${reviewed.length - 1}` : ""}</span>`
    : "";
  const integration = c.integration
    ? `<span class="quality-chip" data-state="${esc(c.integration.status)}">integration ${esc(c.integration.status)}${c.integration.head ? ` ${esc(c.integration.head.slice(0, 8))}` : ""}</span>`
    : "";
  const steering = c.tickets.reduce((count, ticket) => count + Number(ticket.pendingSteers || 0), 0);
  const steeringChip = steering
    ? `<span class="quality-chip" data-state="pending">steering ${steering}</span>`
    : "";
  const legacyChip = (c.legacyAdapters || []).length
    ? `<span class="quality-chip" data-state="legacy">legacy ${esc(c.legacyAdapters.join(", "))}</span>`
    : "";
  return `<div class="campaign-head">
      <div class="eyebrow">${esc(c.project)} / ${esc(c.slug)} · ${esc(c.stage)}</div>
      <h1>${esc(goal || c.slug)}</h1>
      <div class="campaign-location-line">
        <span class="label">Project</span>
        <code>${esc(c.root)}</code>
        <button class="btn ghost" data-act="copy" data-command="${esc(c.root)}" aria-label="Copy project path">Copy</button>
        <span class="label">Campaign</span>
        <code>orchestration/${esc(c.slug)}</code>
      </div>
    </div>
    <div class="campaign-meta">
      <span class="meter" title="${slots} of ${cap} slots busy">${meter}<b>${slots}/${cap}</b> slots</span>
      <span>${c.tickets.length} ticket${c.tickets.length === 1 ? "" : "s"}${c.draft?.tickets ? ` · ${c.draft.tickets} draft` : ""}</span>
      ${reviewedChip}
      ${steeringChip}
      ${integration}
      ${legacyChip}
      <span>${num(c.spend.tokens)} tok · ${usd(c.spend.dollars)}${c.spend.unmetered ? ` · ${esc(c.spend.unmetered)} unmetered` : ""}</span>
      ${c.humanSpend?.tokens ? `<span>human ${num(c.humanSpend.tokens)} tok · ${usd(c.humanSpend.dollars)}</span>` : ""}
      <span>${c.cacheHit == null ? "cache —" : `${(c.cacheHit * 100).toFixed(1)}% cached`}</span>
      <span class="spacer"></span>
      ${campaignControls(c)}
    </div>
    ${nextActionBlock(c)}
    ${campaignSubnav(c)}`;
}

function docBlock(title, text, hint) {
  const body = String(text || "").trim();
  return `<section class="doc-block">
    <h2>${esc(title)}</h2>
    ${body ? `<div class="doc">${esc(body)}</div>` : `<p class="hint">${esc(hint || "Not written yet. Your agent writes this from the plan and the context.")}</p>`}
  </section>`;
}

function contextBlock(c) {
  const context = c.context || {};
  const body = String(context.text || "").trim();
  return `<details class="doc-block context-block">
    <summary><span class="doc-title">Context</span> <span class="hint">raw input · ${context.bytes || 0} bytes${context.truncated ? " · truncated" : ""}</span></summary>
    ${body ? `<pre class="context-raw">${esc(body)}</pre>` : `<p class="hint">No raw context yet. Capture it in your agent session with <span class="mono">orchestrate context append ${esc(c.slug)} --from notes.md</span>.</p>`}
  </details>`;
}

function stageCounts(c) {
  return STAGES.filter((stage) => c.counts?.[stage.id])
    .map(
      (stage) =>
        `<span class="count" data-family="${stage.family}"><b>${c.counts[stage.id]}</b> ${esc(stage.label)}</span>`,
    )
    .join("");
}

function coverageMatrix(coverage) {
  if (!coverage?.matrix?.length) return `<p class="hint">${esc(coverage?.text || "coverage: no campaign criteria")}</p>`;
  return `<table class="coverage-table">
    <thead><tr><th>Criterion</th><th>Tickets</th></tr></thead>
    <tbody>${coverage.matrix
      .map(
        (row) => `<tr data-missing="${row.tickets.length ? "false" : "true"}"><td>${esc(row.criterion)}</td><td class="mono">${esc(row.tickets.join(", ") || "—")}</td></tr>`,
      )
      .join("")}</tbody>
  </table>
  <p class="hint">${esc(coverage.text)}</p>`;
}

function draftBlock(c) {
  if (!c.draft?.exists) return "";
  const draft = c.draft;
  const small = draft.fragmentation?.small?.length || 0;
  const merges = draft.fragmentation?.mergeCandidates?.length || 0;
  const sizing = draft.fragmentation?.blocking
    ? `blocking: ${small} small slices`
    : small >= 3
      ? `${small} small slices`
      : merges
        ? `${merges} merge candidate${merges === 1 ? "" : "s"}`
        : "";
  const blockers = draft.blockers || [];
  const budget = (draft.warnings || []).find((warning) => warning.code === "ticket-budget");
  return `<section class="draft-plan">
    <div class="eyebrow">draft plan · not applied</div>
    <strong>${draft.error ? "Invalid draft" : `${draft.tickets} ticket${draft.tickets === 1 ? "" : "s"}`}</strong>
    <span class="hint">${esc(draft.hash || "")}${draft.updatedAt ? ` · ${esc(clockOf(draft.updatedAt))}` : ""}${draft.openQuestions ? ` · ${draft.openQuestions} open question${draft.openQuestions === 1 ? "" : "s"}` : ""}</span>
    ${sizing ? `<span class="warn">${esc(sizing)}</span>` : ""}
    ${budget ? `<p class="warn">${esc(budget.text)}</p>` : ""}
    ${blockers.length ? `<p class="warn">${esc(blockers.join("; "))}</p>` : ""}
    ${coverageMatrix(draft.coverage)}
    ${draft.clean ? `<button class="btn primary" data-act="approve-campaign" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}">Approve and run</button>` : ""}
    ${commandRow("Review in your agent", `orchestrate plan diff ${c.slug}`)}
    ${commandRow("Inspect the draft", `orchestrate plan show ${c.slug}`)}
    ${draft.error ? `<p class="hint">${esc(draft.error)}</p>` : ""}
  </section>`;
}

function draftBriefing(c) {
  const draft = c.draft;
  const criteria = (draft.criteria || []).map((item) => `- [ ] ${item}`).join("\n");
  const assumptions = (draft.assumptionsList || []).map((item) => `- ${item}`).join("\n");
  const questions = (draft.openQuestionsList || []).map((item) => `- ${item}`).join("\n");
  return `<div class="briefing draft-briefing">
    ${draft.goal ? docBlock("Draft goal", draft.goal) : ""}
    ${docBlock("Brief", draft.brief)}
    ${docBlock("Acceptance criteria", criteria)}
    ${docBlock("Assumptions", assumptions, "None recorded.")}
    ${questions ? docBlock("Open questions", questions) : ""}
    ${docBlock("Constraints", draft.constraints)}
    ${docBlock("What to read first", draft.reading)}
    <p class="hint">This is the draft reviewed in chat; <span class="mono">campaign.md</span> changes only when your agent runs <span class="mono">plan import</span>.</p>
  </div>`;
}

function appliedBriefing(c) {
  return `<div class="briefing">
    ${docBlock("Brief", c.brief)}
    ${docBlock("Acceptance criteria", c.criteria)}
    <section class="doc-block"><h2>Coverage</h2>${coverageMatrix(c.coverage)}</section>
    ${contextBlock(c)}
    ${docBlock("Assumptions", c.assumptions, "No assumptions recorded.")}
    ${c.openQuestions ? docBlock("Open questions", c.openQuestions) : ""}
    ${docBlock("Constraints", c.constraints)}
    ${docBlock("What to read first", c.reading)}
  </div>`;
}

function draftTickets(c) {
  if (!c.draft?.exists || !c.draft.ticketsList?.length) return "";
  return `<section class="draft-tickets">
    <header><span class="eyebrow">draft tickets · not applied</span><span class="hint">${c.draft.ticketsList.length} ticket${c.draft.ticketsList.length === 1 ? "" : "s"} · key is the stable identity</span></header>
    <table class="ticket-table">
      <thead><tr><th>Key</th><th>Title</th><th>Kind</th><th>Blocked by</th><th>Covers</th></tr></thead>
      <tbody>${c.draft.ticketsList
        .map(
          (ticket) => `<tr><td class="mono" data-label="Key">${esc(ticket.key)}</td><td class="title" data-label="Title">${esc(ticket.title)}</td><td class="mono" data-label="Kind">${esc(ticket.kind)}</td><td class="mono" data-label="Blocked by">${esc((ticket.blocked_by || []).join(", ") || "—")}</td><td class="mono" data-label="Covers">${esc((ticket.covers || []).join("; ") || "—")}</td></tr>`,
        )
        .join("")}</tbody>
    </table>
    <p class="hint">Apply in your agent with <span class="mono">orchestrate plan import ${esc(c.slug)}</span> after review.</p>
  </section>`;
}

function planAuditBlock(c) {
  const audit = c.planAudit;
  if (!audit) return "";
  const when = audit.appliedAt ? `applied ${clockOf(audit.appliedAt)}` : "applied time unknown";
  const source = audit.derived ? " · derived from tickets" : "";
  const hash = audit.hash || "hash unknown";
  return `<section class="settings-block">
    <header><h2 class="page">Plan</h2><span class="hint">${esc(when)}${esc(source)} · ${esc(hash)}</span></header>
    <p class="note">${(audit.tickets || []).length} ticket${(audit.tickets || []).length === 1 ? "" : "s"} applied.${audit.assumptions?.length ? ` ${audit.assumptions.length} assumption${audit.assumptions.length === 1 ? "" : "s"} recorded.` : ""}${audit.openQuestions?.length ? ` ${audit.openQuestions.length} open question${audit.openQuestions.length === 1 ? "" : "s"} accepted.` : ""}</p>
    ${audit.assumptions?.length ? `<ul class="plan-list">${audit.assumptions.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}
    ${audit.openQuestions?.length ? `<ul class="plan-list">${audit.openQuestions.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}
  </section>`;
}

function pathRow(label, value, note = "") {
  if (!value) return "";
  return `<div class="path-row">
    <span class="path-label">${esc(label)}</span>
    <code class="path-value">${esc(value)}</code>
    ${note ? `<span class="path-flag">${esc(note)}</span>` : "<span></span>"}
    <button class="btn ghost path-copy" data-act="copy" data-command="${esc(value)}" aria-label="Copy ${esc(label)} path">Copy</button>
  </div>`;
}

function deliveryLine(c) {
  const delivery = c.delivery;
  const branch = delivery?.branch || (c.landing === "branch" ? `orch/${c.slug}/integration` : "");
  const mode = delivery?.mode || (c.landing === "branch" ? "branch" : "direct");
  const target = branch ? `${branch} → ${c.base}` : c.base;
  const integration = c.integration
    ? `integration ${c.integration.status}${c.integration.head ? ` ${c.integration.head.slice(0, 8)}` : ""}`
    : "";
  return `<div class="path-row delivery-row">
    <span class="path-label">Delivery</span>
    <code class="path-value">${esc(mode)} · ${esc(target)}</code>
    <span class="path-flag">${esc(integration)}</span>
    <span></span>
  </div>`;
}

function projectInfo(c) {
  const paths = c.paths || {};
  const plan = paths.planDraftExists
    ? { label: "Plan draft", value: paths.planDraft, note: "not applied" }
    : paths.planAppliedExists
      ? { label: "Applied plan", value: paths.planApplied, note: "" }
      : { label: "Plan draft", value: paths.planDraft, note: "not written yet" };
  return `<section class="project-info">
    <header><h2>Project and files</h2><span class="hint">${esc(c.project || c.root || "")} · on disk</span></header>
    <div class="path-list">
      ${pathRow("Project root", c.root)}
      ${pathRow("Campaign", paths.campaign)}
      ${pathRow("Campaign file", paths.campaignFile, paths.campaignFileExists === false ? "missing" : "")}
      ${pathRow("Tickets", paths.tickets, paths.ticketsExists === false ? "missing" : "")}
      ${pathRow("Context", paths.context, paths.contextExists === false ? "not captured yet" : "")}
      ${pathRow(plan.label, plan.value, plan.note)}
      ${pathRow("Close report", paths.close, paths.closeExists ? "" : "written on close")}
      ${deliveryLine(c)}
    </div>
  </section>`;
}

function campaignOverview(c) {
  const open = (c.inbox || []).filter((item) => item.status === "open").length;
  return `${projectInfo(c)}
    <div class="overview-health">
      ${stageCounts(c) || `<span class="hint">${c.draft?.exists ? "No applied tickets." : "No tickets yet."}</span>`}
      <span class="spacer"></span>
      <span>${open} open question${open === 1 ? "" : "s"}</span>
      <span>${c.counts?.working || 0} running</span>
    </div>
    ${c.tickets.length && (c.planErrors || []).length ? `<div class="errors"><strong>Plan needs attention</strong><ul>${c.planErrors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
    ${!c.tickets.length && !c.draft?.exists ? `<div class="agent-prompt"><span class="hint">Ask your agent, in chat:</span><blockquote>“Plan campaign ${esc(c.slug)}: split the work into tickets and show me the table before importing.”</blockquote><button class="btn ghost" data-act="copy" data-command="Plan campaign ${esc(c.slug)}: split the work into tickets and show me the table before importing.">Copy prompt</button></div>` : ""}
    ${draftBlock(c)}
    ${
      c.draft?.exists && !c.draft.error
        ? `<details class="briefing-details" ${c.draft.blocking ? "open" : ""}><summary>Draft briefing</summary>${draftBriefing(c)}</details>
           <details class="applied-doc"><summary>Applied campaign document</summary>${appliedBriefing(c)}</details>`
        : `<details class="briefing-details"><summary>Briefing</summary>${appliedBriefing(c)}</details>`
    }
    ${ledger(c)}`;
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

function ledger(c, limit = 9) {
  const events = (c.events || []).slice(-limit).reverse();
  if (!events.length) return "";
  return `<section class="ledger">
      <header><h2>Ledger</h2><span class="hint">newest first · showing ${Math.min(limit, c.events.length)} of ${c.events.length}</span></header>
      <ol>${events.map(eventLine).join("")}</ol>
    </section>`;
}

function stageMeta(stage) {
  return STAGES.find((entry) => entry.id === stage) || { id: stage, label: stage, family: "idle" };
}

function shortModel(model) {
  const text = String(model || "").replace(/^[^/]+\//, "").trim();
  return text || "unbound";
}

function cardSummary(t) {
  const text =
    t.stage === "blocked" || t.stage === "queued" || t.stage === "needs_changes"
      ? t.queue?.text || t.summary || t.body
      : t.summary || t.queue?.text || t.body;
  return String(text || "").replace(/\s+/g, " ").trim();
}

function cardStats(t) {
  const stats = [];
  if (t.blockedBy?.length) stats.push(`after ${t.blockedBy.join(", ")}`);
  if (t.attempts > 1) stats.push(`${t.attempts} tries`);
  else if (t.gateCycles) stats.push(`${t.gateCycles} gate${t.gateCycles === 1 ? "" : "s"}`);
  const cost = t.cost?.text;
  if (cost && (t.stage === "done" || t.stage === "dropped") && stats.length < 2) stats.push(cost);
  return stats.slice(0, 2);
}

function kanbanCard(t) {
  const stage = stageMeta(t.stage);
  const summary = cardSummary(t);
  const model = shortModel(t.model || t.workerModel);
  const stats = cardStats(t);
  const owner =
    t.run?.status === "live" && t.run.startedAt
      ? `<span class="elapsed" data-since="${esc(t.run.startedAt)}">${esc(elapsed(t.run.startedAt))}</span> · ${esc(model)}`
      : esc(model);
  return `<article class="kanban-card${fresh.has(t.id) ? " fresh" : ""}" data-family="${esc(stage.family)}" data-stage="${esc(t.stage)}"
      tabindex="0" role="button" data-act="open-ticket" data-root="${esc(selected.root)}" data-campaign="${esc(selected.campaign)}" data-ticket="${esc(t.id)}">
    <div class="kanban-card-top">
      <span class="kanban-id">${esc(t.id)}</span>
      <span class="kanban-kind">${esc(t.kind)}</span>
    </div>
    <h3 class="kanban-title">${esc(t.title)}</h3>
    <span class="kanban-status" data-family="${esc(stage.family)}"><i aria-hidden="true"></i>${esc(stage.label)}</span>
    ${summary ? `<p class="kanban-summary">${esc(summary)}</p>` : ""}
    <div class="kanban-meta">
      <span class="kanban-owner" title="${esc(model)}">${owner}</span>
      <span class="kanban-stats">${stats.map(esc).join(" · ")}</span>
    </div>
  </article>`;
}

function kanbanLane(lane, tickets) {
  return `<section class="kanban-lane" data-family="${esc(lane.family)}" data-lane="${esc(lane.id)}" data-count="${tickets.length}" aria-label="${esc(lane.label)} lane">
    <header class="kanban-lane-head">
      <span class="kanban-dot" aria-hidden="true"></span>
      <h2>${esc(lane.label)}</h2>
      <span class="kanban-count">${tickets.length}</span>
    </header>
    <div class="kanban-cards">
      ${tickets.length ? tickets.map(kanbanCard).join("") : `<p class="kanban-empty">${esc(lane.empty)}</p>`}
    </div>
  </section>`;
}

function ticketFilter(c) {
  const kinds = [...new Set(c.tickets.map((t) => t.kind))].sort();
  return `<div class="ticket-toolbar" data-view="${esc(ticketView)}">
      <div class="ticket-counts">${stageCounts(c)}</div>
      <div class="segmented" role="group" aria-label="Ticket view">
        <button data-act="ticket-view" data-view="list" aria-pressed="${ticketView === "list"}">List</button>
        <button data-act="ticket-view" data-view="board" aria-pressed="${ticketView === "board"}">Kanban</button>
        <button data-act="ticket-view" data-view="graph" aria-pressed="${ticketView === "graph"}">Graph</button>
      </div>
      <select data-role="ticket-kind" aria-label="Filter by kind">
        <option value="all">all kinds</option>
        ${kinds.map((kind) => `<option ${ticketKind === kind ? "selected" : ""}>${esc(kind)}</option>`).join("")}
      </select>
      <input type="text" data-role="ticket-search" value="${esc(ticketQuery)}" placeholder="Search tickets…" aria-label="Search tickets" />
    </div>`;
}

function filteredTickets(c) {
  const query = ticketQuery.trim().toLowerCase();
  return c.tickets.filter((ticket) => {
    if (ticketKind !== "all" && ticket.kind !== ticketKind) return false;
    if (
      query &&
      !`${ticket.id} ${ticket.title} ${ticket.kind} ${ticket.stage} ${ticket.model || ""}`
        .toLowerCase()
        .includes(query)
    )
      return false;
    return true;
  });
}

function ticketList(c, tickets) {
  return `<table class="ticket-table">
      <thead><tr><th>#</th><th>Title</th><th>Kind</th><th>Stage</th><th>Model</th><th class="num">Cost</th><th>Blocked by</th></tr></thead>
      <tbody>
        ${
          tickets
            .map(
              (t) => `<tr tabindex="0" role="button" data-act="open-ticket" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" data-ticket="${esc(t.id)}">
              <td class="mono" data-label="#">${esc(t.id)}</td>
              <td class="title" data-label="Title">${esc(t.title)}</td>
              <td class="mono" data-label="Kind">${esc(t.kind)}</td>
              <td data-label="Stage"><span class="badge" data-family="${esc((STAGES.find((s) => s.id === t.stage) || {}).family || "idle")}">${esc(t.stage)}</span></td>
              <td class="mono" data-label="Model">${esc(t.model || "—")}</td>
              <td class="num mono" data-label="Cost">${esc(t.cost?.text || (t.unmetered ? "included" : "—"))}</td>
              <td class="mono" data-label="Blocked by">${esc((t.blockedBy || []).join(", ") || "—")}</td>
            </tr>`,
            )
            .join("") || `<tr><td colspan="7" class="hint">No tickets match.</td></tr>`
        }
      </tbody>
    </table>`;
}

function ticketBoard(c, tickets) {
  return `<div class="ticket-board">${KANBAN_LANES.map((lane) =>
    kanbanLane(lane, tickets.filter((ticket) => lane.stages.includes(ticket.stage))),
  ).join("")}</div>`;
}

function ticketGraph(c, tickets) {
  if (!tickets.length) return `<div class="ticket-graph-wrap"><p class="hint">No tickets match.</p></div>`;
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const allById = new Map(c.tickets.map((ticket) => [ticket.id, ticket]));
  const dependentIds = new Set();
  for (const ticket of c.tickets) {
    for (const blocker of ticket.blockedBy || []) {
      if (allById.has(blocker)) dependentIds.add(blocker);
    }
  }
  const isIndependent = (ticket) => !(ticket.blockedBy || []).length && !dependentIds.has(ticket.id);
  const depth = new Map();
  const visiting = new Set();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ticket = byId.get(id);
    const blockers = (ticket?.blockedBy || []).filter((blocker) => byId.has(blocker));
    const value = blockers.length ? 1 + Math.max(...blockers.map(depthOf)) : 0;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const ticket of tickets) depthOf(ticket.id);
  const maxDepth = Math.max(0, ...tickets.map((ticket) => depth.get(ticket.id) || 0));
  const columns = Array.from({ length: maxDepth + 1 }, () => []);
  for (const ticket of tickets) columns[depth.get(ticket.id) || 0].push(ticket);
  for (const column of columns) column.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const nodeW = 230, nodeH = 68, gapX = 64, gapY = 18, pad = 24;
  const rows = Math.max(1, ...columns.map((column) => column.length));
  const width = pad * 2 + (maxDepth + 1) * nodeW + maxDepth * gapX;
  const height = pad * 2 + rows * nodeH + (rows - 1) * gapY;
  const pos = new Map();
  columns.forEach((column, index) => {
    column.forEach((ticket, row) => {
      pos.set(ticket.id, { x: pad + index * (nodeW + gapX), y: pad + row * (nodeH + gapY) });
    });
  });
  const family = (stage) => (STAGES.find((entry) => entry.id === stage) || {}).family || "idle";
  const edges = [];
  for (const ticket of tickets) {
    for (const blocker of ticket.blockedBy || []) {
      const from = pos.get(blocker);
      const to = pos.get(ticket.id);
      if (!from || !to) continue;
      const x1 = from.x + nodeW, y1 = from.y + nodeH / 2;
      const x2 = to.x, y2 = to.y + nodeH / 2;
      const bend = Math.max(24, (x2 - x1) / 2);
      edges.push(`<path class="graph-edge" d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" marker-end="url(#graph-arrow)" />`);
    }
  }
  const nodes = [];
  for (const ticket of tickets) {
    const point = pos.get(ticket.id);
    const title = ticket.title.length > 29 ? `${ticket.title.slice(0, 28)}…` : ticket.title;
    const independent = isIndependent(ticket);
    nodes.push(`<g class="graph-node" data-family="${esc(family(ticket.stage))}" data-independent="${independent}" tabindex="0" role="button"
        data-act="open-ticket" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" data-ticket="${esc(ticket.id)}">
        <title>${esc(`${ticket.id} ${ticket.title} · ${ticket.stage}${independent ? " · independent" : ""}`)}</title>
        <rect x="${point.x}" y="${point.y}" width="${nodeW}" height="${nodeH}" rx="4" />
        <text class="graph-id" x="${point.x + 12}" y="${point.y + 21}">${esc(ticket.id)}</text>
        ${independent ? `<text class="graph-independent" x="${point.x + nodeW - 10}" y="${point.y + 21}" text-anchor="end">independent</text>` : ""}
        <text class="graph-title" x="${point.x + 12}" y="${point.y + 41}">${esc(title)}</text>
        <text class="graph-meta" x="${point.x + 12}" y="${point.y + 57}">${esc(ticket.kind)} · ${esc(ticket.stage)}</text>
      </g>`);
  }
  return `<div class="ticket-graph-wrap">
    <div class="graph-legend">
      <span><i class="legend-edge" aria-hidden="true"></i> blocked_by edge</span>
      <span><i class="legend-independent" aria-hidden="true"></i> independent ticket</span>
    </div>
    <p class="hint">Arrows run from a blocker to the ticket it blocks. A ticket with no arrows declared no <span class="mono">blocked_by</span> and nothing depends on it. Click a ticket to open it.</p>
    <svg class="ticket-graph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Ticket dependency graph">
      <defs><marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
      ${edges.join("")}
      ${nodes.join("")}
    </svg>
  </div>`;
}

function newTicketForm(c) {
  const kinds = Object.keys(c.effectiveKinds || {});
  return `<details class="new-ticket" ${c.tickets.length || c.draft?.exists ? "" : "open"}>
    <summary>New ticket</summary>
    <div class="grid">
      <div class="field" style="grid-template-columns:88px 1fr"><label for="t-title">Title</label><input id="t-title" name="t_title" type="text" placeholder="What this slice delivers" /></div>
      <div class="field" style="grid-template-columns:88px 1fr"><label for="t-kind">Kind</label>
        <select id="t-kind" name="t_kind">${kinds.map((k) => `<option ${k === "code" ? "selected" : ""}>${esc(k)}</option>`).join("")}</select>
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
      <span class="hint">Lands in <span class="mono">orchestration/${esc(c.slug)}/tickets/</span> with the next number. For several tickets at once, ask your agent to run <span class="mono">plan import</span>.</span>
    </div>
  </details>`;
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

function campaignTickets(c) {
  const tickets = filteredTickets(c);
  const body =
    ticketView === "graph" ? ticketGraph(c, tickets) : ticketView === "board" ? ticketBoard(c, tickets) : ticketList(c, tickets);
  const empty = !c.tickets.length
    ? `<div class="empty">
      <h2>${c.draft?.exists ? "No applied tickets yet." : "No tickets yet."}</h2>
      <p>${c.draft?.exists ? "The draft above is not applied; review it in chat, then run plan import." : "Add one here, or ask your agent to write the plan for you."}</p>
      ${c.draft?.exists ? "" : `<div class="agent-prompt">
        <span class="hint">Ask your agent, in chat:</span>
        <blockquote>“Add a ticket to ${esc(c.slug)} for the CLI slice: kind code, touches src/cli/**, blocked by 01, acceptance: add prints added.”</blockquote>
        <button class="btn ghost" data-act="copy" data-command="Add a ticket to ${esc(c.slug)} for the CLI slice: kind code, touches src/cli/**, blocked by 01, acceptance: add prints added.">Copy prompt</button>
        <span class="hint">Or add one from the CLI:</span>
        ${commandRow("Add one ticket", `orchestrate ticket add "CLI slice" --campaign ${c.slug} --kind code --touches "src/cli/**" --blocked-by 01 --what "Add and list commands." --accept "add prints added"`)}
        <span class="hint">Or import a whole graph:</span>
        ${commandRow("Import a plan", `orchestrate plan import ${c.slug} --file plan.yml`)}
      </div>`}
    </div>`
    : "";
  return `${draftBlock(c)}
    ${draftTickets(c)}
    ${ticketFilter(c)}
    ${c.tickets.length ? `<div id="ticket-list">${body}</div>` : ""}
    ${empty}
    ${newTicketForm(c)}`;
}

function paintTickets() {
  const c = current();
  const box = document.getElementById("ticket-list");
  if (!c || !box) return;
  const tickets = filteredTickets(c);
  box.innerHTML =
    ticketView === "graph" ? ticketGraph(c, tickets) : ticketView === "board" ? ticketBoard(c, tickets) : ticketList(c, tickets);
  const counts = document.querySelector(".ticket-counts");
  if (counts) counts.innerHTML = stageCounts(c);
}

function campaignConfigure(c) {
  const kinds = Object.entries(c.effectiveKinds || {});
  const checks = (c.checks || []).map((k) => `${k.name} | ${k.cmd}`).join("\n");
  const attrs = `data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}"`;
  return `<p class="note">Plan text is read-only here. Edit the brief and the ticket graph in your agent session; this screen owns the runtime configuration.</p>
    <div class="config-grid">
      <section class="settings-block">
        <header><h2 class="page">Delivery</h2><span class="hint">how the campaign is allowed to finish</span></header>
        <div class="config-fields">
          <div class="field"><label for="autonomy">Autonomy</label><div class="stack">
            <select id="autonomy" name="autonomy">
              ${["supervised", "trusted", "unattended"].map((v) => `<option ${c.autonomy === v ? "selected" : ""}>${v}</option>`).join("")}
            </select>
            <span class="sub">supervised: you take every delivery. trusted: verified work under the limit ships. unattended: anything that passes ships.</span>
          </div></div>
          <div class="field"><label for="plan_gate">Plan gate</label><div class="stack">
            <select id="plan_gate" name="plan_gate">${["human", "auto"].map((v) => `<option ${c.planGate === v ? "selected" : ""}>${v}</option>`).join("")}</select>
            <span class="sub">human: dispatch waits for approval in your agent.</span>
          </div></div>
          <div class="field"><label for="landing">Landing</label><div class="stack">
            <select id="landing" name="landing">${["branch", "directory"].map((v) => `<option ${c.landing === v ? "selected" : ""}>${v}</option>`).join("")}</select>
          </div></div>
          <div class="field"><label for="base">Base</label><input id="base" name="base" type="text" value="${esc(c.base)}" /></div>
        </div>
      </section>

      <section class="settings-block">
        <header><h2 class="page">Runtime</h2><span class="hint">models, tools and billing</span></header>
        <div class="config-fields">
          <div class="field"><label>Adapter</label><div class="stack">${adapterSelect("campaign")}<span class="sub">models, tools and billing of this campaign</span></div></div>
          <div class="field"><label>Spend</label><div class="stack">${spendSelect("campaign")}<span class="sub">subscription-only hides metered models</span></div></div>
          <details class="advanced">
            <summary>Advanced</summary>
            <div class="config-fields">
              <div class="field"><label>Sandbox</label><div class="stack">${sandboxSelect("campaign")}<span class="sub">bwrap isolates writes on Linux</span></div></div>
              <div class="field"><label>ACP permissions</label><div class="stack">${acpPermissionSelect("campaign")}<span class="sub">ask shows Allow / Deny in Sessions</span></div></div>
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
          </details>
        </div>
      </section>
    </div>

    <details class="advanced">
      <summary>Advanced <span class="hint">checks, generated paths, quotas</span></summary>
      <div class="config-grid">
        <section class="settings-block">
          <header><h2 class="page">Checks</h2><span class="hint">the supervisor runs these in the ticket's worktree</span></header>
          <textarea class="mono" name="checks" rows="4" placeholder="tests | node --test" aria-label="Checks">${esc(checks)}</textarea>
          <p class="sub" style="margin:6px 0 0">One per line, <span class="mono">name | command</span>.</p>
        </section>
        <section class="settings-block">
          <header><h2 class="page">Generated paths</h2><span class="hint">never counted as drift</span></header>
          <input name="allow_paths" type="text" value="${esc((c.allowPaths || []).join(", "))}" placeholder="package-lock.json, snapshots/**" aria-label="Generated paths" />
          <p class="sub" style="margin:6px 0 0">Lockfiles, snapshots and other files a worker regenerates without declaring them.</p>
        </section>
      </div>
      <section class="settings-block">
        <header><h2 class="page">Provider quotas</h2><span class="hint">campaign additions and overrides</span></header>
        ${quotaEditor("campaign")}
      </section>
    </details>

    <section class="chains">
      <header><h2 class="page">Model chains</h2><span class="hint">first model starts the ticket; each next one is the fallback</span><button class="btn" data-act="defaults" data-scope="campaign">Use defaults</button><button class="btn" data-act="refresh-catalog" data-scope="campaign">Refresh models</button></header>
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

    <div class="save-bar">
      <button class="btn primary" data-act="save-campaign" ${attrs}>Save configuration</button>
      <span class="hint">Changes are validated before they are written. Pause the campaign before changing chains.</span>
    </div>`;
}

function deliveryBlock(c) {
  const delivery = c.delivery;
  if (!delivery) return "";
  const branch = delivery.branch || `orch/${c.slug}/integration`;
  const base = c.base || "main";
  const manual = delivery.mode === "manual";
  const merged = delivery.mode === "merged";
  const cleaned = (c.attention?.cleanups || 0) > 0;
  return `<section class="settings-block">
    <header><h2 class="page">Delivery</h2><span class="hint">${esc(delivery.mode)} · ${esc(branch)} → ${esc(base)}</span></header>
    ${delivery.detail ? `<p class="note">${esc(delivery.detail)}</p>` : ""}
    ${
      manual
        ? `<p class="note">Open a PR from <span class="mono">${esc(branch)}</span> into <span class="mono">${esc(base)}</span>, or merge locally and remove the worktree and branches in the same decision.</p>
           ${commandRow("Review the delivery", "orchestrate acceptance")}
           ${commandRow("Push the branch", `git push origin ${branch}`)}`
        : ""
    }
    ${
      merged
        ? `<p class="note">Merged into <span class="mono">${esc(base)}</span>. ${cleaned ? "The integration worktree and campaign branches are removed." : "The integration worktree and campaign branches can be removed; the base checkout stays."}</p>
           ${cleaned ? "" : commandRow("Preview cleanup", `orchestrate cleanup ${c.slug} --dry-run`)}
           ${cleaned ? "" : commandRow("Remove branches and worktree", `orchestrate cleanup ${c.slug}`)}`
        : ""
    }
    ${commandRow("Close the campaign", `orchestrate archive ${c.slug}`)}
  </section>`;
}

function attentionBlock(c) {
  const attention = c.attention;
  if (!attention) return "";
  return `<section class="settings-block">
    <header><h2 class="page">Attention</h2><span class="hint">human actions</span></header>
    <dl class="attention-list">
      <dt>Approvals</dt><dd>${attention.approvals}</dd>
      <dt>Questions answered</dt><dd>${attention.answers}</dd>
      <dt>Deliveries reviewed</dt><dd>${attention.reviews}</dd>
      <dt>Cleanups</dt><dd>${attention.cleanups}</dd>
      <dt>Steers</dt><dd>${attention.steers || 0}</dd>
      <dt>Total</dt><dd><b>${attention.total}</b></dd>
    </dl>
  </section>`;
}

function campaignHistory(c) {
  const spend = c.spendByModel || [];
  const human = c.humanSpend || { tokens: 0, dollars: 0, turns: 0 };
  const humanRows = (c.humanSessions || []).slice().reverse();
  return `${planAuditBlock(c)}
    ${draftBlock(c)}
    ${attentionBlock(c)}
    <section class="history-spend">
      <header><h2 class="page">Spend and cache</h2><span class="hint">${num(c.spend.tokens)} tokens · ${usd(c.spend.dollars)} · ${c.cacheHit == null ? "cache —" : `${(c.cacheHit * 100).toFixed(1)}% cached read`}</span></header>
      <table class="ticket-table">
        <thead><tr><th>Model</th><th class="num">Runs</th><th class="num">Tokens</th><th class="num">Cached read</th><th class="num">Cache hit</th><th class="num">Cost</th></tr></thead>
        <tbody>
          ${
            spend
              .map(
                (row) => `<tr><td class="mono" data-label="Model">${esc(row.model)}</td><td class="num" data-label="Runs">${row.runs}</td><td class="num" data-label="Tokens">${num(row.tokens)}</td><td class="num" data-label="Cached read">${num(row.cachedReadTokens)}</td><td class="num" data-label="Cache hit">${row.cacheHit == null ? "—" : `${(row.cacheHit * 100).toFixed(1)}%`}</td><td class="num" data-label="Cost">${usd(row.dollars)}</td></tr>`,
              )
              .join("") || `<tr><td colspan="6" class="hint">No runs yet.</td></tr>`
          }
        </tbody>
      </table>
    </section>
    <section class="history-spend">
      <header><h2 class="page">Human sessions</h2><span class="hint">${human.turns} terminal session${human.turns === 1 ? "" : "s"} · ${num(human.tokens)} tokens · ${usd(human.dollars)}</span></header>
      ${
        humanRows.length
          ? `<table class="ticket-table">
              <thead><tr><th>#</th><th>Mode</th><th class="num">Tokens</th><th class="num">Cost</th><th>When</th></tr></thead>
              <tbody>${humanRows
                .map(
                  (row) => `<tr><td class="mono" data-label="#">${esc(row.ticket)}</td><td class="mono" data-label="Mode">${esc(row.mode || "attach")}</td><td class="num" data-label="Tokens">${num(row.tokens)}</td><td class="num" data-label="Cost">${usd(row.dollars)}</td><td class="mono" data-label="When">${esc(clockOf(row.at))}</td></tr>`,
                )
                .join("")}</tbody>
            </table>`
          : `<p class="hint">No human terminal sessions recorded. Hand-back reports are attributed to the ticket's normal runs.</p>`
      }
    </section>
    ${ledger(c, 40)}
    <section class="settings-block">
      <header><h2 class="page">Decisions</h2><span class="hint">written by you or the orchestrator · read by workers on these paths</span></header>
      <ol class="decision-list">
        ${
          (c.decisions || []).length
            ? c.decisions
                .map(
                  (d) => `<li>
                  <span class="scope">${esc(d.scope === "console" ? "shared" : d.by)}</span>
                  <span class="text">${esc(d.text)}</span>
                  <span class="cite">${esc(d.cite || "")}</span>
                  ${d.scope === "campaign" ? `<button class="btn ghost" data-act="copy" data-command="orchestrate promote ${esc(d.id)} ${esc(c.slug)}">share</button>` : ""}
                </li>`,
                )
                .join("")
            : `<li class="empty"><span class="text">Nothing yet. Answers to worker questions land here, and every worker on these paths reads them.</span></li>`
        }
      </ol>
    </section>
    ${deliveryBlock(c)}`;
}

function sessionTickets(c) {
  return (c.tickets || []).filter((ticket) => ticket.session?.id || ticket.session?.exists);
}

function sessionState(ticket) {
  if (ticket.owner === "human") return { label: "human", family: "person" };
  if (ticket.session?.adapter === "agy-acp") return { label: "gemini", family: "active" };
  if (ticket.session?.adapter && ticket.session.adapter !== "pi") return { label: "legacy", family: "idle" };
  if (ticket.session?.live) return { label: "live", family: "active" };
  if (ticket.session?.exists) return { label: "idle", family: "done" };
  return { label: "no session", family: "idle" };
}

function sessionRow(c, ticket, active) {
  const state = sessionState(ticket);
  return `<button class="session-row${active ? " active" : ""}" data-act="session-select" data-ticket="${esc(ticket.id)}" aria-current="${active}">
    <span class="session-row-top"><span class="mono">${esc(ticket.id)}</span><span class="session-pill" data-family="${esc(state.family)}">${esc(state.label)}</span></span>
    <span class="session-row-title">${esc(ticket.title)}</span>
    <span class="session-row-meta">${esc(ticket.model || ticket.session?.model || "unbound")}</span>
  </button>`;
}

function campaignSessions(c) {
  const tickets = sessionTickets(c);
  const chosen = tickets.find((ticket) => ticket.id === sessionTicket) || tickets[0] || c.tickets[0] || null;
  if (chosen) sessionTicket = chosen.id;
  if (!c.tickets.length) {
    return `<div class="empty"><h2>No sessions yet.</h2><p>A ticket gets a pi session after its first work run.</p></div>`;
  }
  const sessionId = chosen?.session?.id || "";
  const owner = chosen?.owner === "human";
  const live = Boolean(chosen?.session?.live);
  const adapter = chosen?.session?.adapter || null;
  const acp = adapter === "agy-acp";
  const legacy = adapter && adapter !== "pi" && adapter !== "agy-acp";
  const hasSession = Boolean(chosen?.session?.exists);
  const question = (c.inbox || []).find(
    (item) => item.status === "open" && item.ticket === chosen?.id && (item.kind === "question" || item.kind === "needs_answer"),
  );
  return `<div class="sessions-workspace" data-session-ticket="${esc(chosen?.id || "")}">
    <aside class="session-list" aria-label="Ticket sessions">
      <header><span class="eyebrow">sessions</span><span class="hint">${tickets.filter((ticket) => ticket.session?.exists || ticket.session?.adapter === "agy-acp").length}/${c.tickets.length} with history</span></header>
      <div class="session-list-body">${c.tickets.map((ticket) => sessionRow(c, ticket, ticket.id === chosen?.id)).join("")}</div>
    </aside>
    <section class="session-room">
      <header class="session-room-head">
        <div>
          <div class="eyebrow">${esc(c.slug)} / ${esc(chosen?.id || "—")} · ${esc(chosen?.stage || "")}</div>
          <h2>${esc(chosen?.title || "Select a ticket")}</h2>
          <div class="session-room-meta">
            <span>${owner ? "human-owned" : live ? "supervisor running" : "read-only history"}</span>
            <span class="mono">${esc(chosen?.model || chosen?.session?.model || "no model")}</span>
            ${sessionId ? `<span class="mono">${esc(sessionId)}</span>` : ""}
          </div>
        </div>
        <div class="actions session-actions">
          ${hasSession && !legacy && !acp ? `<button class="btn ghost" data-act="session-fork">Fork</button>` : ""}
          ${owner && !live && !acp ? `<button class="btn" data-act="session-attach">Attach</button>` : ""}
          ${!owner && chosen?.session?.id && !["done", "dropped"].includes(chosen.stage) && !legacy && !acp ? `<button class="btn signal" data-act="session-takeover">Stop and take over</button>` : ""}
          ${owner && !live && !acp ? `<button class="btn primary" data-act="session-handback">Hand back</button>` : ""}
          ${hasSession && !acp ? `<button class="btn ghost" data-act="session-copy">Copy command</button>` : ""}
          ${acp && live ? `<button class="btn signal" data-act="acp-stop">Stop run</button>` : ""}
        </div>
      </header>
      ${legacy ? `<div class="session-unavailable">Legacy ACP session. Use the agent or CLI; the pi terminal is not available.</div>` : ""}
      ${acp ? `<div class="session-unavailable">Gemini ticket through agy ACP. Read the ACP transcript here${["done", "dropped"].includes(chosen?.stage) ? "." : "; send a steer below or from the Leader terminal."}</div>` : ""}
      ${acp ? `<div id="acp-permissions" class="acp-permissions"></div>` : ""}
      ${acp && !["done", "dropped"].includes(chosen?.stage) ? `<div class="acp-steer">
        <textarea id="acp-message" rows="2" placeholder="Steer this Gemini ticket…"></textarea>
        <button class="btn" data-act="acp-steer">Send steer</button>
      </div>` : ""}
      ${!hasSession && !acp ? `<div class="session-unavailable">This ticket has no pi session yet. It gets one after the first work run.</div>` : ""}
      ${question ? `<div class="session-question">
        <span class="eyebrow">needs you</span>
        <p>${esc(question.question?.text || question.title || "The worker needs an answer.")}</p>
        ${(question.question?.options || []).length ? `<p class="hint">options: ${question.question.options.map(esc).join(" · ")}</p>` : ""}
        <textarea id="session-answer-text" rows="2" placeholder="Answer the worker…"></textarea>
        <div class="actions"><button class="btn primary" data-act="session-answer" data-item="${esc(question.id)}">Answer</button></div>
      </div>` : ""}
      <div class="session-body">
        <section class="session-transcript" id="session-transcript" aria-label="Session transcript">
          <p class="hint">Loading transcript…</p>
        </section>
        <section class="terminal-shell">
          <header class="terminal-head">
            <span id="terminal-status">${acp ? "agy ACP session" : owner ? "terminal detached" : "read-only fork"}</span>
            <span class="actions">
              ${acp ? (window.__ORCH_APP__ ? `<button class="btn ghost" data-act="acp-native">Open native agy</button>` : "") : `<button class="btn ghost" data-act="session-reconnect">Connect</button>`}
            </span>
          </header>
          <div class="terminal-host" id="terminal-host">
            ${acp ? `<div class="terminal-placeholder">No pi PTY for a Gemini ticket. The ACP transcript is on the left.</div>` : hasSession && !legacy ? `<div class="terminal-placeholder">Choose <b>Fork</b> for a read-only copy, or take over to type in this session.</div>` : ""}
          </div>
        </section>
      </div>
      <details class="session-raw">
        <summary>Raw run log</summary>
        <div class="session-raw-box" id="session-raw-log"><button class="btn ghost" data-act="session-raw">Load the latest run log</button></div>
      </details>
      ${owner && !acp ? `<div class="handback-bar">
        <textarea id="handback-note" rows="2" placeholder="What changed? Hand-back note for the supervisor…"></textarea>
        <span class="hint">Hand back writes a report, runs the checks, then the normal review and integration.</span>
      </div>` : ""}
    </section>
  </div>`;
}

function transcriptMessage(message) {
  const role = message.role;
  if (role === "system") return "";
  const text = String(message.text || "");
  if (role === "thinking") {
    return `<details class="thread-tool-result"><summary><span class="thread-role">thinking</span></summary><pre>${esc(text)}</pre></details>`;
  }
  if (role === "tool") {
    return `<div class="thread-message" data-role="assistant"><span class="thread-role">tool</span><div class="thread-text">${esc(text)}</div></div>`;
  }
  if (role === "permission") {
    return `<div class="thread-message" data-role="assistant"><span class="thread-role">permission</span><div class="thread-text">${esc(text)}</div></div>`;
  }
  if (role === "toolResult") {
    return `<details class="thread-tool-result">
      <summary><span class="thread-role">${esc(message.toolName || "tool")}</span> result</summary>
      <pre>${esc(text)}</pre>
    </details>`;
  }
  if (role === "user") {
    if (text.length > 1400) {
      return `<details class="thread-prompt"><summary><span class="thread-role">user</span> ticket prompt · ${text.length} chars</summary><pre>${esc(text)}</pre></details>`;
    }
    return `<div class="thread-message" data-role="user"><span class="thread-role">user</span><div class="thread-text">${esc(text)}</div></div>`;
  }
  const tools = (message.toolCalls || [])
    .map((call) => {
      const args = call.args?.command || call.args?.path || JSON.stringify(call.args || {});
      return `<div class="thread-call"><span class="thread-tool">${esc(call.name)}</span><code>${esc(String(args).slice(0, 900))}</code></div>`;
    })
    .join("");
  if (!text && !tools) return "";
  return `<div class="thread-message" data-role="assistant">
    <span class="thread-role">${esc(role === "plan" ? "plan" : "assistant")}</span>
    ${text ? `<div class="thread-text">${esc(text)}</div>` : ""}
    ${tools}
  </div>`;
}

function renderTranscript(data) {
  const box = document.getElementById("session-transcript");
  if (!box) return;
  const messages = (data.messages || []).map(transcriptMessage).filter(Boolean);
  box.innerHTML = `<div class="thread-head"><span>${data.total || messages.length} messages</span><span>${data.truncated ? "tail only" : "full session"}</span></div>
    ${messages.join("") || `<p class="hint">No readable messages yet.</p>`}`;
}

async function loadTranscript() {
  const c = current();
  const ticket = c?.tickets.find((t) => t.id === sessionTicket);
  const box = document.getElementById("session-transcript");
  if (!box) return;
  if (ticket?.session?.adapter === "agy-acp") {
    const run = ticket.session?.acpRunId || ticket.run?.id;
    if (!run) {
      sessionTranscriptKey = null;
      sessionTranscriptData = null;
      box.innerHTML = `<p class="hint">No ACP run yet. The transcript appears after the first Gemini turn.</p>`;
      return;
    }
    const key = `acp:${c.root}/${c.slug}/${ticket.id}/${run}`;
    if (key === sessionTranscriptKey) {
      if (sessionTranscriptData) renderTranscript(sessionTranscriptData);
      return;
    }
    sessionTranscriptKey = key;
    try {
      const data = await api(`/api/acp-transcript?project=${encodeURIComponent(c.root)}&campaign=${encodeURIComponent(c.slug)}&run=${encodeURIComponent(run)}`);
      sessionTranscriptData = data;
      renderTranscript(data);
    } catch (err) {
      sessionTranscriptData = null;
      box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    }
    return;
  }
  if (!ticket?.session?.id || !ticket.session.exists) {
    sessionTranscriptKey = null;
    sessionTranscriptData = null;
    box.innerHTML = `<p class="hint">${ticket?.session?.adapter && ticket.session.adapter !== "pi" ? "Legacy ACP session; no pi transcript." : "No pi session file yet."}</p>`;
    return;
  }
  const key = `${c.slug}/${ticket.id}/${ticket.session.id}`;
  if (key === sessionTranscriptKey) {
    if (sessionTranscriptData) renderTranscript(sessionTranscriptData);
    return;
  }
  sessionTranscriptKey = key;
  try {
    const data = await api(`/api/transcript?project=${encodeURIComponent(c.root)}&campaign=${encodeURIComponent(c.slug)}&session=${encodeURIComponent(ticket.session.id)}`);
    sessionTranscriptData = data;
    renderTranscript(data);
  } catch (err) {
    sessionTranscriptData = null;
    box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(script);
  });
}

async function ensureXterm() {
  if (!window.Terminal) await loadScript("/vendor/xterm/xterm.js");
  if (!window.FitAddon) await loadScript("/vendor/xterm/addon-fit.js");
  if (!window.Terminal || !window.FitAddon) throw new Error("xterm.js did not load");
}

function terminalTheme() {
  return document.documentElement.dataset.theme === "light"
    ? { background: "#f1f3ee", foreground: "#12171a", cursor: "#bf4128", selectionBackground: "#c2cac3" }
    : { background: "#0a0c11", foreground: "#e9ecf3", cursor: "#ff6f4d", selectionBackground: "#232936" };
}

function setTerminalStatus(text, state = "") {
  const el = document.getElementById(terminalStatusId);
  if (!el) return;
  el.textContent = text;
  el.dataset.state = state;
}

function terminalCommand(c, ticket, mode) {
  const session = ticket?.session;
  if (!session?.id) return "";
  const args = mode === "attach"
    ? `--session-id ${session.id} --session-dir ${c.paths?.sessions || ".orchestration/campaigns/" + c.slug + "/sessions"}`
    : `--fork ${session.id} --session-dir ${c.paths?.sessions || ".orchestration/campaigns/" + c.slug + "/sessions"} --tools read,grep,find,ls`;
  return `cd ${session.workdir || c.root} && pi ${args}`;
}

function disposeTerminal({ keepStatus = false, terminate = false } = {}) {
  const shouldTerminate = terminate || sessionTermMode === "fork";
  clearTimeout(sessionTakeoverTimer);
  sessionTakeoverTimer = null;
  if (sessionAppId && window.__TAURI__) {
    window.__TAURI__.core.invoke("pty_close", { id: sessionAppId }).catch(() => {});
    sessionAppId = null;
  }
  if (sessionAppCleanup.length) {
    for (const cleanup of sessionAppCleanup) {
      try {
        cleanup();
      } catch {
        /* already gone */
      }
    }
    sessionAppCleanup = [];
  }
  if (sessionSocket) {
    if (shouldTerminate && sessionSocket.readyState === 1) {
      try {
        sessionSocket.send(JSON.stringify({ type: "terminate" }));
      } catch {
        /* already gone */
      }
    }
    try {
      sessionSocket.close(1000, shouldTerminate ? "terminate" : "detach");
    } catch {
      /* already closed */
    }
    sessionSocket = null;
  }
  if (sessionTerm) {
    try {
      sessionTerm.dispose();
    } catch {
      /* already disposed */
    }
    sessionTerm = null;
  }
  sessionFit = null;
  sessionTermKey = null;
  sessionTermMode = null;
  const host = document.getElementById("terminal-host");
  if (host && !keepStatus) host.innerHTML = "";
}

function fitTerminal() {
  if (!sessionFit) return;
  try {
    sessionFit.fit();
  } catch {
    /* hidden or zero-size */
  }
}

async function connectTerminal(mode = null) {
  if (window.matchMedia("(max-width: 860px)").matches) {
    toast("The embedded terminal is desktop-only; use the transcript or a native pi session");
    return;
  }
  const c = current();
  const ticket = c?.tickets.find((t) => t.id === sessionTicket);
  if (!c || !ticket) return;
  if (!sessionStatus) {
    await refreshSessionStatus();
  }
  if (!sessionStatus?.available) {
    setTerminalStatus(sessionStatus?.reason || "terminal unavailable", "error");
    toast(sessionStatus?.reason || "terminal unavailable");
    return;
  }
  const chosen = mode || sessionStatus.mode || "fork";
  if (chosen === "attach" && !sessionStatus.canAttach) {
    toast("Stop the run and take over before attaching");
    return;
  }
  try {
    await ensureXterm();
  } catch (err) {
    setTerminalStatus(err.message, "error");
    return;
  }
  const previousMode = sessionTermMode;
  disposeTerminal({ terminate: previousMode === "fork" });
  const host = document.getElementById("terminal-host");
  if (!host) return;
  host.innerHTML = "";
  const term = new window.Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    fontSize: 15,
    lineHeight: 1.25,
    scrollback: 5000,
    theme: terminalTheme(),
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  sessionTerm = term;
  sessionFit = fit;
  sessionTermKey = `${c.root}|${c.slug}/${ticket.id}/${chosen}`;
  sessionTermMode = chosen;
  setTimeout(fitTerminal, 30);
  if (window.__ORCH_APP__ && window.__TAURI__) {
    await connectAppTerminal(term, c, ticket, chosen);
    return;
  }
  const url = new URL("/api/terminal", location.origin);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("project", c.root);
  url.searchParams.set("campaign", c.slug);
  url.searchParams.set("ticket", ticket.id);
  url.searchParams.set("mode", chosen);
  url.searchParams.set("cols", String(term.cols || 100));
  url.searchParams.set("rows", String(term.rows || 30));
  if (token) url.searchParams.set("token", token);
  const ws = new WebSocket(url);
  sessionSocket = ws;
  setTerminalStatus(chosen === "attach" ? "connecting to session…" : "opening read-only fork…");
  ws.onopen = () => setTerminalStatus(chosen === "attach" ? "attached · you own this session" : "fork · read-only", "live");
  ws.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "data") term.write(message.data);
    if (message.type === "ready") {
      if (message.buffer) term.write(message.buffer);
      setTerminalStatus(chosen === "attach" ? "attached · you own this session" : "fork · read-only", "live");
      fitTerminal();
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
    if (message.type === "exit") setTerminalStatus(`session exited (${message.code ?? "?"})`, "ended");
    if (message.type === "error") setTerminalStatus(message.error, "error");
  };
  ws.onerror = () => setTerminalStatus("terminal connection failed", "error");
  ws.onclose = () => setTerminalStatus((sessionStatus?.owner === "human" ? "detached · session kept" : "fork closed"), "ended");
  term.onData((data) => {
    if (sessionSocket?.readyState === 1) sessionSocket.send(JSON.stringify({ type: "input", data }));
  });
  term.onResize(({ cols, rows }) => {
    if (sessionSocket?.readyState === 1) sessionSocket.send(JSON.stringify({ type: "resize", cols, rows }));
  });
}

async function openAppTerminalTicket(term, issued, label) {
  const id = await window.__TAURI__.core.invoke("pty_open", { ticket: issued.ticket });
  sessionAppId = id;
  const unlistenData = await window.__TAURI__.event.listen("pty:data", (event) => {
    if (event.payload?.id === id) term.write(event.payload.data || "");
  });
  const unlistenExit = await window.__TAURI__.event.listen("pty:exit", (event) => {
    if (event.payload?.id !== id) return;
    setTerminalStatus("session exited", "ended");
    sessionAppId = null;
  });
  sessionAppCleanup.push(unlistenData, unlistenExit);
  term.onData((data) => {
    if (sessionAppId) window.__TAURI__.core.invoke("pty_write", { id: sessionAppId, data }).catch(() => {});
  });
  term.onResize(({ cols, rows }) => {
    if (sessionAppId) window.__TAURI__.core.invoke("pty_resize", { id: sessionAppId, cols, rows }).catch(() => {});
  });
  setTerminalStatus(label, "live");
  setTimeout(fitTerminal, 30);
}

async function connectAppTerminal(term, c, ticket, mode) {
  setTerminalStatus("requesting terminal ticket…");
  try {
    const issued = await api("/api/app/terminal-ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: c.root, campaign: c.slug, ticket: ticket.id, mode }),
    });
    await openAppTerminalTicket(term, issued, mode === "attach" ? "attached · you own this session" : "fork · read-only");
  } catch (err) {
    setTerminalStatus(`terminal failed: ${err.message || err}`, "error");
  }
}

async function connectAgyTerminal(term, c, ticket) {
  try {
    const issued = await api("/api/app/agy-ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: c.root, campaign: c.slug, ticket: ticket.id }),
    });
    await openAppTerminalTicket(term, issued, "agy · native conversation");
  } catch (err) {
    setTerminalStatus(`agy failed: ${err.message || err}`, "error");
  }
}

async function connectAgyNative() {
  if (!window.__ORCH_APP__ || !window.__TAURI__) {
    toast("The native agy terminal is available in the desktop app");
    return;
  }
  const c = current();
  const ticket = c?.tickets.find((t) => t.id === sessionTicket);
  if (!c || !ticket) return;
  terminalStatusId = "terminal-status";
  const host = document.getElementById("terminal-host");
  if (!host) return;
  try {
    await ensureXterm();
  } catch (err) {
    setTerminalStatus(err.message, "error");
    return;
  }
  disposeTerminal();
  host.innerHTML = "";
  const term = new window.Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    fontSize: 15,
    lineHeight: 1.25,
    scrollback: 5000,
    theme: terminalTheme(),
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  sessionTerm = term;
  sessionFit = fit;
  sessionTermMode = "agy";
  sessionTermKey = `${c.root}|${c.slug}/${ticket.id}/agy`;
  setTimeout(fitTerminal, 30);
  setTerminalStatus("opening native agy conversation…");
  await connectAgyTerminal(term, c, ticket);
}

async function connectLeaderTerminal(term, root) {
  try {
    const issued = await api("/api/app/leader-ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    });
    await openAppTerminalTicket(term, issued, "leader · pi with the orchestration skill");
  } catch (err) {
    setTerminalStatus(`leader failed: ${err.message || err}`, "error");
  }
}

async function refreshSessionStatus() {
  const c = current();
  const ticket = c?.tickets.find((t) => t.id === sessionTicket);
  if (!c || !ticket) return;
  try {
    sessionStatus = await api(
      `/api/terminal/status?project=${encodeURIComponent(c.root)}&campaign=${encodeURIComponent(c.slug)}&ticket=${encodeURIComponent(ticket.id)}`,
    );
  } catch (err) {
    sessionStatus = { ok: false, available: false, reason: err.message };
  }
  const status = document.getElementById("terminal-status");
  if (status && !sessionTerm) {
    status.textContent = sessionStatus.available ? (sessionStatus.canAttach ? "terminal detached" : "read-only fork") : sessionStatus.reason;
    status.dataset.state = sessionStatus.available ? "" : "error";
  }
}

async function loadRawLog() {
  const c = current();
  const ticket = c?.tickets.find((t) => t.id === sessionTicket);
  const box = document.getElementById("session-raw-log");
  if (!c || !ticket || !box) return;
  const run = ticket.run?.id;
  if (!run) {
    box.innerHTML = `<p class="hint">No run log for this ticket yet.</p>`;
    return;
  }
  box.innerHTML = `<p class="hint">Loading ${esc(run)}…</p>`;
  try {
    const data = await api(
      `/api/log?project=${encodeURIComponent(c.root)}&campaign=${encodeURIComponent(c.slug)}&run=${encodeURIComponent(run)}&offset=0`,
    );
    const text = String(data.text || "");
    const shown = text.slice(0, 80_000);
    box.innerHTML = `<div class="hint">${esc(run)} · ${num(data.size)} bytes${shown.length < data.size ? " · first 80 KB" : ""}</div>
      <pre>${esc(shown) || "Log is empty."}</pre>`;
  } catch (err) {
    box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
  }
}

function stopAcpPolling() {
  clearInterval(acpPermissionTimer);
  acpPermissionTimer = null;
}

async function refreshAcpPermissions() {
  const box = document.getElementById("acp-permissions");
  if (!box) return;
  const c = current();
  const ticket = c?.tickets.find((t) => t.id === sessionTicket);
  const run = ticket?.session?.acpRunId;
  if (!c || !run || ticket?.session?.adapter !== "agy-acp") return;
  try {
    const data = await api(`/api/acp/pending?project=${encodeURIComponent(c.root)}&campaign=${encodeURIComponent(c.slug)}&run=${encodeURIComponent(run)}`);
    const pending = data.pending || [];
    box.innerHTML = pending.length
      ? pending
          .map(
            (request) => `<div class="acp-permission">
              <div class="acp-permission-head"><span class="eyebrow">permission</span><b>${esc(request.title || "tool call")}</b></div>
              ${(request.paths || []).length ? `<code>${esc(request.paths.join(" · "))}</code>` : ""}
              <div class="actions">
                <button class="btn primary" data-act="acp-decision" data-request="${esc(request.id)}" data-decision="allow">Allow</button>
                <button class="btn signal" data-act="acp-decision" data-request="${esc(request.id)}" data-decision="deny">Deny</button>
              </div>
            </div>`,
          )
          .join("")
      : "";
  } catch (err) {
    box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
  }
}

function startAcpPolling() {
  stopAcpPolling();
  refreshAcpPermissions();
  acpPermissionTimer = setInterval(refreshAcpPermissions, 1500);
}

async function decideAcpPermission(request, decision) {
  const c = current();
  const ticket = c?.tickets.find((t) => t.id === sessionTicket);
  const run = ticket?.session?.acpRunId;
  if (!c || !run) return;
  try {
    await api("/api/acp/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: c.root, campaign: c.slug, run, request, decision }),
    });
    toast(`${decision === "allow" ? "Allowed" : "Denied"} · ${request}`);
    await refreshAcpPermissions();
  } catch (err) {
    toast(err.message);
  }
}

async function mountSessions() {
  const c = current();
  const ticket = c?.tickets.find((t) => t.id === sessionTicket);
  if (ticket?.session?.adapter === "agy-acp") {
    terminalStatusId = "terminal-status";
    setTerminalStatus("agy ACP session", "live");
    await loadTranscript();
    startAcpPolling();
    return;
  }
  await refreshSessionStatus();
  await loadTranscript();
}

function takeoverSession() {
  const c = current();
  const ticket = c?.tickets.find((t) => t.id === sessionTicket);
  if (!c || !ticket) return;
  command(c.root, { type: "session.takeover", campaign: c.slug, ticket: ticket.id });
  sessionTranscriptKey = null;
  sessionTranscriptData = null;
  setTerminalStatus("stopping the run…");
  clearInterval(sessionTakeoverTimer);
  let tries = 0;
  sessionTakeoverTimer = setInterval(async () => {
    tries++;
    await refreshSessionStatus();
    if (sessionStatus?.canAttach) {
      clearInterval(sessionTakeoverTimer);
      sessionTakeoverTimer = null;
      await load({ quiet: true });
      await connectTerminal("attach");
      return;
    }
    if (tries > 20) {
      clearInterval(sessionTakeoverTimer);
      sessionTakeoverTimer = null;
      setTerminalStatus("takeover did not finish; check the ticket state", "error");
    }
  }, 800);
}

function handbackSession() {
  const c = current();
  const ticket = c?.tickets.find((t) => t.id === sessionTicket);
  if (!c || !ticket) return;
  const note = String(document.getElementById("handback-note")?.value || "").trim();
  if (!note) {
    toast("Add a hand-back note first");
    return;
  }
  disposeTerminal({ terminate: true });
  sessionTranscriptKey = null;
  sessionTranscriptData = null;
  setTimeout(() => {
    command(c.root, { type: "session.handback", campaign: c.slug, ticket: ticket.id, note });
  }, 150);
}

function copySessionCommand() {
  const c = current();
  const ticket = c?.tickets.find((t) => t.id === sessionTicket);
  if (!c || !ticket) return;
  const commandText = terminalCommand(c, ticket, sessionStatus?.canAttach ? "attach" : "fork");
  if (!commandText) return toast("No session to open");
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(commandText).then(() => toast("Copied"), () => copyFallback(commandText));
  else copyFallback(commandText);
}

function allSessionRows() {
  const rows = [];
  for (const campaign of campaigns()) {
    for (const ticket of sessionTickets(campaign)) rows.push({ campaign, ticket });
  }
  return rows.sort(
    (a, b) =>
      Number(Boolean(b.ticket.session?.live)) - Number(Boolean(a.ticket.session?.live)) ||
      a.campaign.slug.localeCompare(b.campaign.slug) ||
      a.ticket.id.localeCompare(b.ticket.id),
  );
}

function viewSessions() {
  const projects = leaderProjects();
  const root = leaderRoot || selected.root || projects[0]?.root || "";
  leaderRoot = root;
  const rows = allSessionRows();
  const appMode = Boolean(window.__ORCH_APP__);
  const options = projects
    .map((project) => `<option value="${esc(project.root)}" ${project.root === root ? "selected" : ""}>${esc(project.name)} · ${esc(project.root)}</option>`)
    .join("");
  const leader = `<section class="sessions-leader">
    <div>
      <div class="eyebrow">leader · pi</div>
      <h2>Plan in a Leader chat</h2>
      <p class="note">One pi session loaded with the orchestration skill. Start a campaign, draft the ticket graph, approve the plan, and answer workers from here.</p>
      ${appMode ? "" : `<p class="hint">The Leader chat opens in the desktop app. Worker sessions are below.</p>`}
    </div>
    <div class="sessions-leader-actions">
      <label class="field"><span>Project</span>
        <select data-role="leader-project" ${projects.length ? "" : "disabled"}>${options || `<option>No projects registered</option>`}</select>
      </label>
      <button class="btn primary" data-act="open-leader" ${appMode && projects.length ? "" : "disabled"}>Open Leader chat</button>
    </div>
  </section>`;
  const body = rows.length
    ? `<div class="fleet-wrap"><table class="ticket-table session-table">
        <thead><tr><th>Project</th><th>Campaign</th><th>Ticket</th><th>State</th><th>Model</th><th></th></tr></thead>
        <tbody>${rows
          .map(({ campaign, ticket }) => {
            const state = sessionState(ticket);
            return `<tr>
              <td class="mono" data-label="Project">${esc(campaign.project)}</td>
              <td class="mono" data-label="Campaign">${esc(campaign.slug)}</td>
              <td data-label="Ticket"><span class="mono">${esc(ticket.id)}</span> ${esc(ticket.title)}</td>
              <td data-label="State"><span class="session-pill" data-family="${esc(state.family)}">${esc(state.label)}</span></td>
              <td class="mono" data-label="Model">${esc(ticket.model || ticket.session?.model || "—")}</td>
              <td class="num"><button class="btn ghost" data-act="open-session" data-root="${esc(campaign.root)}" data-campaign="${esc(campaign.slug)}" data-ticket="${esc(ticket.id)}">Open</button></td>
            </tr>`;
          })
          .join("")}</tbody>
      </table></div>`
    : `<div class="empty">
        <h2>No worker sessions yet.</h2>
        <p>A ticket gets a session after its first work run. Start a campaign from the <b>Leader chat</b>, then return here.</p>
        ${appMode ? `<button class="btn primary" data-act="open-leader">Open Leader chat</button>` : ""}
      </div>`;
  return `<div class="sessions-view">
    <div>
      <h1 class="page">Sessions</h1>
      <p class="lede">The Leader plans; each ticket run gets its own worker session. Both are one click away.</p>
    </div>
    ${leader}
    <section class="sessions-worker">
      <div class="sessions-head">
        <div><div class="eyebrow">workers</div><h2>Worker sessions</h2></div>
        <span class="hint">${rows.length} session${rows.length === 1 ? "" : "s"} across ${campaigns().length} campaign${campaigns().length === 1 ? "" : "s"}</span>
      </div>
      ${body}
    </section>
  </div>`;
}

function openLeader() {
  goView("leader");
  setTimeout(() => connectLeader(), 80);
}

function leaderProjects() {
  return state?.projects || [];
}

function viewLeader() {
  const projects = leaderProjects();
  const root = leaderRoot || selected.root || projects[0]?.root || "";
  leaderRoot = root;
  const agy = (state?.adapters || []).find((adapter) => adapter.id === "agy-acp");
  const gemini = agy?.adapterVersion
    ? `agy ${agy.adapterVersion} detected · Gemini tickets can bind to agy-acp`
    : "Gemini needs agy installed and authenticated; the app detects it automatically";
  const options = projects
    .map((project) => `<option value="${esc(project.root)}" ${project.root === root ? "selected" : ""}>${esc(project.name)} · ${esc(project.root)}</option>`)
    .join("");
  return `<div class="leader-view">
    <section class="leader-intro">
      <div>
        <div class="eyebrow">leader · pi</div>
        <h1>Plan with the orchestrator</h1>
        <p class="note">A pi session loaded with the orchestration skill. Use it to start a campaign, draft the ticket graph, approve the plan, and answer worker questions.</p>
        <p class="hint">${esc(gemini)}</p>
      </div>
      <div class="leader-controls">
        <label class="field"><span>Project</span>
          <select data-role="leader-project" ${projects.length ? "" : "disabled"}>${options || `<option>No projects registered</option>`}</select>
        </label>
        <button class="btn primary" data-act="leader-connect" ${projects.length ? "" : "disabled"}>Open Leader terminal</button>
        <button class="btn ghost" data-act="leader-copy">Copy command</button>
        <button class="btn ghost" data-act="agy-login">${agy?.adapterVersion ? "agy login" : "Set up agy"}</button>
      </div>
    </section>
    ${projects.length ? "" : `<div class="empty"><h2>No project yet.</h2><p>Use <b>Open repository…</b> in the rail, then return here.</p></div>`}
    <section class="leader-terminal">
      <header class="terminal-head">
        <span id="leader-status">not connected</span>
        <span class="actions"><button class="btn ghost" data-act="leader-connect">Connect</button></span>
      </header>
      <div class="terminal-host leader-host" id="terminal-host"><div class="terminal-placeholder">Open the Leader to start a pi session loaded with the orchestration skill.</div></div>
    </section>
  </div>`;
}

function mountLeader() {
  terminalStatusId = "leader-status";
}

async function connectLeader() {
  if (!window.__ORCH_APP__ || !window.__TAURI__) {
    toast("The Leader terminal is available in the desktop app");
    return;
  }
  const root = leaderRoot || selected.root || leaderProjects()[0]?.root;
  if (!root) {
    toast("Open a project first");
    return;
  }
  terminalStatusId = "leader-status";
  const host = document.getElementById("terminal-host");
  if (!host) return;
  try {
    await ensureXterm();
  } catch (err) {
    setTerminalStatus(err.message, "error");
    return;
  }
  disposeTerminal();
  host.innerHTML = "";
  const term = new window.Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    fontSize: 15,
    lineHeight: 1.25,
    scrollback: 5000,
    theme: terminalTheme(),
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  sessionTerm = term;
  sessionFit = fit;
  sessionTermMode = "leader";
  sessionTermKey = `leader|${root}`;
  setTimeout(fitTerminal, 30);
  setTerminalStatus("starting leader…");
  await connectLeaderTerminal(term, root);
}

async function copyLeaderCommand() {
  const root = leaderRoot || selected.root || leaderProjects()[0]?.root;
  if (!root) return toast("Open a project first");
  let skill = "<path-to-orchestration-skill>";
  if (window.__TAURI__) {
    try {
      skill = (await window.__TAURI__.core.invoke("runtime_status")).skill;
    } catch {
      /* fall back to the placeholder */
    }
  }
  const command = `cd ${root} && pi --session-id orch-app-leader --skill ${skill}/SKILL.md`;
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(command).then(() => toast("Copied"), () => copyFallback(command));
  else copyFallback(command);
}

function viewCampaign() {
  const c = current();
  if (!c) return noCampaigns();
  const body =
    campaignTab === "tickets"
      ? campaignTickets(c)
      : campaignTab === "sessions"
        ? campaignSessions(c)
        : campaignTab === "configure"
          ? campaignConfigure(c)
          : campaignTab === "history"
            ? campaignHistory(c)
            : campaignOverview(c);
  return `${campaignHeader(c)}${body}`;
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
      <label class="num-field"><span>ACP permissions</span>${acpPermissionSelect("console")}</label>
    </div>
    <p class="note" style="margin:8px 0 0">Subscription-only hides metered models; metered-ok shows every discovered model with its price. Changing the adapter changes which catalog the chains below can pick from.</p>
  </section>

  <section class="settings-block">
    <header><h2 class="page">Provider quotas</h2><span class="hint">windows that hold back dispatch when exhausted</span></header>
    <p class="note" style="margin:-4px 0 12px">Match a model by provider, or by adapter for a whole subscription. A campaign can add its own windows in Campaign → Provider quotas. Stale data is displayed but never enforced.</p>
    ${quotaEditor("console")}
  </section>

  <section class="settings-block">
    <header><h2 class="page">Ticket kinds</h2><span class="hint">first model starts the ticket; each next one is the fallback</span><button class="btn" data-act="defaults" data-scope="console">Use defaults</button></header>
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
  </section>

  <section class="settings-block">
    <header><h2 class="page">Appearance</h2><span class="hint">this window only</span></header>
    <div class="appearance-row">
      <span class="appearance-label">Theme</span>
      <div class="segmented" role="group" aria-label="Theme">
        <button data-act="theme" data-theme="dark">dark</button>
        <button data-act="theme" data-theme="light">light</button>
      </div>
      <span class="appearance-label">Text size</span>
      <div class="segmented" role="group" aria-label="Text size">
        <button data-act="text-size" data-size="16">S</button>
        <button data-act="text-size" data-size="18">M</button>
        <button data-act="text-size" data-size="21">L</button>
      </div>
    </div>
    <p class="note">${window.__ORCH_RUNTIME__ ? `App runtime · ${esc(runtimeLabel())}` : "Browser panel · runtime information appears in the desktop app."}</p>
  </section>

  <section class="settings-block">
    <header><h2 class="page">Updates</h2><span class="hint" id="update-hint">signed AppImage updates</span></header>
    <div class="actions">
      <button class="btn" data-act="update-check">Check for updates</button>
      <button class="btn primary" data-act="update-install" id="update-install" hidden>Install update</button>
    </div>
    <p class="note">The app reads the signed update manifest and verifies the AppImage signature before replacing itself.</p>
  </section>`;
}

function updateHint() {
  return document.getElementById("update-hint");
}

async function checkUpdates() {
  if (!window.__TAURI__?.core) return toast("Updates are available in the desktop app");
  const hint = updateHint();
  if (hint) hint.textContent = "checking the signed manifest…";
  try {
    const info = await window.__TAURI__.core.invoke("update_check");
    if (hint) hint.textContent = info.available ? `version ${info.version} is available` : `up to date · ${info.current}`;
    const install = document.getElementById("update-install");
    if (install) install.hidden = !info.available;
  } catch (err) {
    if (hint) hint.textContent = String(err.message || err);
    toast(String(err.message || err));
  }
}

async function installUpdate() {
  if (!window.__TAURI__?.core) return toast("Updates are available in the desktop app");
  const install = document.getElementById("update-install");
  if (install) {
    install.disabled = true;
    install.textContent = "Installing…";
  }
  try {
    await window.__TAURI__.core.invoke("update_install");
  } catch (err) {
    toast(String(err.message || err));
    if (install) {
      install.disabled = false;
      install.textContent = "Install update";
    }
  }
}

function noCampaigns() {
  return `<div class="empty">
      <h2>No campaigns yet.</h2>
      <p>A campaign starts in your agent session: one goal, free-form context, and a ticket graph the agent imports. This panel watches it and configures the fleet.</p>
      ${commandRow("Start a campaign", 'orchestrate start "<goal>"')}
    </div>`;
}

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
    dirtyViews.delete(surface());
    toast(`${body.type.replace(/\./g, " ")} queued`);
    setTimeout(() => load(), body.type === "catalog.refresh" ? 3500 : 350);
    setTimeout(() => load({ quiet: true }), 2600);
    return true;
  } catch (err) {
    dirtyViews.add(surface());
    toast(err.message);
    return false;
  }
}

function saveCampaign(root, slug) {
  const c = campaignOf(root, slug);
  if (!c) return;
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
    runner: { adapter: value("adapter") || adapterFor("campaign"), spend: value("spend") || "metered-ok", sandbox: value("sandbox") || "auto", acpPermission: value("acp_permission") || "auto" },
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
  return command(root, { type: "campaign.save", campaign: slug, patch });
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
        acpPermission: value("acp_permission") || "auto",
      },
      quotas: readQuotaRows("console"),
    },
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
      if (view === "campaign" && campaignTab === "tickets") document.querySelectorAll(".kanban-card.fresh").forEach((el) => el.classList.remove("fresh"));
    }, 1400);
  }
}

/* --- drawer --------------------------------------------------------------- */

function openTicket(root, slug, ticketId) {
  const c = campaignOf(root, slug);
  const t = c?.tickets.find((x) => x.id === ticketId);
  if (!c || !t) return;
  selected = { root: c.root, campaign: c.slug };
  drawer = { root, slug, ticket: t.id };
  drawerEl.hidden = false;
  drawerEl.innerHTML = drawerHtml(c, t);
  history.replaceState(null, "", `#ticket/${encodeURIComponent(t.id)}`);
  startLog(c, t);
}

function findingsHtml(findings) {
  if (!findings) return `<p class="hint">No findings recorded.</p>`;
  if (typeof findings === "string") return `<pre class="log">${esc(findings)}</pre>`;
  const order = ["blocker", "high", "medium", "low"];
  return order
    .map((severity) => {
      const rows = findings.filter((finding) => finding.severity === severity);
      if (!rows.length) return "";
      return `<h3>${esc(severity)} <span class="hint">${rows.length}</span></h3><ul>${rows
        .map(
          (finding) =>
            `<li><span class="mono">[${esc(finding.id)}]</span> ${esc(finding.file || "")}${finding.line ? `:${esc(finding.line)}` : ""}<br>${esc(finding.problem)}<br><em>Required: ${esc(finding.requiredFix)}</em></li>`,
        )
        .join("")}</ul>`;
    })
    .join("");
}

function acceptanceHtml(t) {
  if (!Array.isArray(t.acceptance) || !t.acceptance.length) {
    return `<p class="hint">No acceptance evidence recorded yet.</p>`;
  }
  return `<table class="evidence-table"><thead><tr><th>Criterion</th><th>Status</th><th>Evidence</th></tr></thead><tbody>${t.acceptance
    .map(
      (result) =>
        `<tr data-status="${esc(result.status)}"><td>${esc(result.criterion)}</td><td>${esc(result.status)}</td><td>${esc(result.evidence || "—")}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

function steersHtml(c, t) {
  const steers = t.steers || [];
  if (!steers.length) return `<p class="hint">No steering notes.</p>`;
  return `<ul class="steer-list">${steers
    .slice()
    .reverse()
    .map(
      (steer) =>
        `<li data-status="${esc(steer.status)}"><span class="mono">${esc(steer.id)}</span> <span class="badge" data-family="${steer.status === "pending" ? "person" : steer.status === "delivered" ? "active" : "idle"}">${esc(steer.status)}</span> <span class="hint">${esc(steer.mode)} · ${esc(clockOf(steer.at))}</span><p>${esc(String(steer.text || "").slice(0, 500))}${String(steer.text || "").length > 500 ? "…" : ""}</p>${
          steer.status === "pending"
            ? `<button class="btn ghost" data-act="steer-cancel" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" data-ticket="${esc(t.id)}">Cancel pending</button>`
            : ""
        }</li>`,
    )
    .join("")}</ul>`;
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
    ${(t.sources || []).length ? `<h2>Sources</h2><div class="doc">${(t.sources || []).map((p) => `· ${esc(p)}`).join("\n")}</div>` : ""}
    ${t.answer ? `<h2>Last answer</h2><div class="doc">${esc(t.answer.text)}${t.answer.citation ? `\n${esc(t.answer.citation)}` : ""}</div>` : ""}
    <details class="evidence">
      <summary>Evidence <span class="hint">acceptance, findings, reviewed revision</span></summary>
      <h3>Acceptance</h3>
      ${acceptanceHtml(t)}
      <h3>Findings</h3>
      ${findingsHtml(t.findings)}
      <dl class="evidence-meta">
        <dt>gate cycles</dt><dd>${esc(t.gateCycles || 0)}</dd>
        <dt>review model</dt><dd class="mono">${esc(t.reviewModel || "—")}</dd>
        <dt>worker model</dt><dd class="mono">${esc(t.workerModel || "—")}</dd>
        <dt>reviewed</dt><dd class="mono">${esc(t.reviewedHead ? t.reviewedHead.slice(0, 8) : "—")}${t.reviewStale ? " (stale)" : ""}</dd>
        <dt>integration</dt><dd>${esc(c.integration ? `${c.integration.status}${c.integration.head ? ` ${c.integration.head.slice(0, 8)}` : ""}` : "not run")}</dd>
      </dl>
    </details>
    <section class="steering">
      <h2>Steering <span class="hint">person notes for the worker</span></h2>
      ${steersHtml(c, t)}
    </section>
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
    ${commandRow("Edit in your agent", `orchestrate ticket edit ${t.id} --campaign ${c.slug} --title "…"`)}
    ${t.stage === "needs_answer" ? commandRow("Answer in your agent", "orchestrate inbox") : ""}
  </div>
  <footer class="drawer-foot">${drawerActions(c, t)}</footer>`;
}

function drawerActions(c, t) {
  const live = Boolean(t.run && t.run.status === "live");
  const attrs = `data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" data-ticket="${esc(t.id)}"`;
  const buttons = [];
  if (live) buttons.push(`<button class="btn signal" data-act="stop" ${attrs}>Stop run</button>`);
  if (["failed", "needs_changes"].includes(t.stage)) buttons.push(`<button class="btn" data-act="retry" ${attrs}>Retry ticket</button>`);
  if (!buttons.length) {
    const note = { done: "Landed. Nothing to do here.", dropped: "Dropped: there was no work.", queued: "Queued. The next tick dispatches it.", working: "Running. Watch the log, or stop the run.", needs_answer: "Waiting for a decision in your agent session." }[t.stage] || "";
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
      history.replaceState(null, "", `#campaign/${encodeURIComponent(selected.campaign)}/${campaignTab}`);
    } else {
      syncFleetUrl();
    }
  }
}

function routeFromHash() {
  const raw = location.hash.slice(1);
  const [name, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  if (name.startsWith("ticket/")) {
    const id = decodeURIComponent(name.slice("ticket/".length));
    if (current() && id) openTicket(current().root, current().slug, id);
    return;
  }
  if (name.startsWith("campaign/")) {
    const [slugPart, tabPart] = decodeURIComponent(name.slice("campaign/".length)).split("/");
    const found = campaigns().find((c) => c.slug === slugPart);
    if (found) selected = { root: found.root, campaign: found.slug };
    view = "campaign";
    campaignTab = CAMPAIGN_TABS.includes(tabPart) ? tabPart : "overview";
    closeDrawer();
    render();
    return;
  }
  if (name === "campaign") {
    const found =
      (params.get("campaign") && campaigns().find((c) => c.slug === params.get("campaign"))) ||
      (selected.campaign && campaigns().find((c) => c.slug === selected.campaign)) ||
      campaigns()[0];
    if (found) {
      selected = { root: found.root, campaign: found.slug };
      view = "campaign";
      campaignTab = "overview";
      history.replaceState(null, "", `#campaign/${encodeURIComponent(found.slug)}`);
      closeDrawer();
      render();
      return;
    }
  }
  if (name === "board") {
    const found = selected.campaign
      ? campaigns().find((c) => c.slug === selected.campaign && (!selected.root || c.root === selected.root))
      : campaigns()[0];
    if (found) {
      selected = { root: found.root, campaign: found.slug };
      view = "campaign";
      campaignTab = "tickets";
      ticketView = "board";
      history.replaceState(null, "", `#campaign/${encodeURIComponent(found.slug)}/tickets`);
      closeDrawer();
      render();
      return;
    }
  }
  if (VIEWS.includes(name)) {
    const nextStatus = FLEET_STATUS.includes(params.get("status")) ? params.get("status") : "all";
    const campaignParam = params.get("campaign");
    let nextCampaign = selected.campaign;
    let nextRoot = selected.root;
    if (campaignParam !== null) {
      if (!campaignParam) {
        nextCampaign = null;
        nextRoot = null;
      } else {
        const found = campaigns().find((c) => c.slug === campaignParam);
        if (found) {
          nextCampaign = found.slug;
          nextRoot = found.root;
        }
      }
    }
    const changed =
      name !== view ||
      nextStatus !== fleetStatus ||
      (params.get("project") || "") !== fleetProject ||
      (params.get("adapter") || "") !== fleetAdapter ||
      (params.get("q") || "") !== fleetQuery ||
      nextCampaign !== selected.campaign ||
      nextRoot !== selected.root;
    view = name;
    fleetStatus = nextStatus;
    fleetProject = params.get("project") || "";
    fleetAdapter = params.get("adapter") || "";
    fleetQuery = params.get("q") || "";
    selected = { root: nextRoot, campaign: nextCampaign };
    fleetLimit = 200;
    if (changed) {
      closeDrawer();
      render();
    }
  }
}

/* --- events --------------------------------------------------------------- */

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
      const res = await fetch(new URL("/api/attachments", API_BASE), {
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
  toast("file attached");
}

let folderState = { path: null, parent: null };

async function openFolder(path) {
  try {
    const browse = new URL("/api/browse", API_BASE);
    browse.searchParams.set("path", path || "");
    const res = await fetch(browse, {
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
    const res = await fetch(new URL("/api/projects", API_BASE), {
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
  const ticketSearch = event.target.closest('[data-role="ticket-search"]');
  if (ticketSearch) {
    ticketQuery = ticketSearch.value;
    paintTickets();
    return;
  }
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
  const files = event.target.closest("input[data-role='attach-files']");
  if (files) {
    uploadAttachments(files);
    return;
  }
  const ticketKindSelect = event.target.closest('[data-role="ticket-kind"]');
  if (ticketKindSelect) {
    ticketKind = ticketKindSelect.value;
    paintTickets();
    return;
  }
  const leaderProject = event.target.closest('[data-role="leader-project"]');
  if (leaderProject) {
    leaderRoot = leaderProject.value;
    if (sessionTermMode === "leader") disposeTerminal();
    return;
  }
  const fleetCampaignSelect = event.target.closest("[data-role='fleet-campaign']");
  if (fleetCampaignSelect) {
    const val = fleetCampaignSelect.value;
    if (!val) {
      selected = { root: null, campaign: null };
    } else {
      const opt = fleetCampaignSelect.selectedOptions?.[0];
      const root = opt?.dataset.root || campaigns().find((c) => c.slug === val)?.root || null;
      selected = { root, campaign: val };
      const cur = campaignOf(selected.root, selected.campaign);
      if (cur && fleetProject && cur.project !== fleetProject && cur.root !== fleetProject) {
        fleetProject = "";
      }
    }
    fleetLimit = 200;
    render();
    return syncFleetUrl();
  }
  const fleetProjectSelect = event.target.closest("[data-role='fleet-project']");
  if (fleetProjectSelect) {
    fleetProject = fleetProjectSelect.value;
    if (fleetProject && selected.campaign) {
      const cur = campaignOf(selected.root, selected.campaign);
      if (cur && cur.project !== fleetProject && cur.root !== fleetProject) {
        selected = { root: null, campaign: null };
      }
    }
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
  if (event.target.closest("#app")) dirtyViews.add(surface());
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
  switch (act) {
    case "go": {
      dirtyViews.clear();
      const next = target.dataset.view;
      if (next === "campaign" && selected.campaign) {
        view = "campaign";
        campaignTab = target.dataset.tab || "overview";
        history.replaceState(null, "", `#campaign/${encodeURIComponent(selected.campaign)}/${campaignTab}`);
        return render();
      }
      view = next;
      history.replaceState(null, "", `#${view}`);
      return render();
    }
    case "leader-connect":
      return connectLeader();
    case "open-leader":
      return openLeader();
    case "open-session": {
      const found = campaignOf(root, campaign);
      if (!found) return toast("That campaign is no longer loaded");
      selected = { root: found.root, campaign: found.slug };
      sessionTicket = ticket;
      campaignTab = "sessions";
      view = "campaign";
      closeDrawer();
      history.replaceState(null, "", `#campaign/${encodeURIComponent(found.slug)}/sessions`);
      return render();
    }
    case "leader-copy":
      return copyLeaderCommand();
    case "agy-login": {
      const command = "agy acp --login";
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(command).then(() => toast("Copied. Paste it in the Leader terminal."), () => copyFallback(command));
      else copyFallback(command);
      return;
    }
    case "copy": {
      copyText(target.dataset.command || "");
      return;
    }
    case "campaign-tab": {
      campaignTab = CAMPAIGN_TABS.includes(target.dataset.tab) ? target.dataset.tab : "overview";
      closeDrawer();
      history.replaceState(null, "", `#campaign/${encodeURIComponent(selected.campaign)}/${campaignTab}`);
      return render();
    }
    case "ticket-view":
      ticketView = ["board", "graph"].includes(target.dataset.view) ? target.dataset.view : "list";
      return render();
    case "session-select":
      disposeTerminal();
      sessionStatus = null;
      sessionTranscriptKey = null;
      sessionTranscriptData = null;
      sessionTicket = target.dataset.ticket || null;
      return render();
    case "session-fork":
      return connectTerminal("fork");
    case "session-attach":
      return connectTerminal("attach");
    case "session-takeover":
      return takeoverSession();
    case "session-handback":
      return handbackSession();
    case "session-answer": {
      const text = String(document.getElementById("session-answer-text")?.value || "").trim();
      if (!text) {
        toast("Write an answer first");
        return;
      }
      return command(selected.root, { type: "answer", campaign: selected.campaign, item, text });
    }
    case "acp-native":
      return connectAgyNative();
    case "acp-stop":
      return command(selected.root, { type: "stop", campaign: selected.campaign, ticket: sessionTicket });
    case "acp-decision": {
      const request = target.dataset.request || "";
      const decision = target.dataset.decision === "allow" ? "allow" : "deny";
      return decideAcpPermission(request, decision);
    }
    case "acp-steer": {
      const text = String(document.getElementById("acp-message")?.value || "").trim();
      if (!text) {
        toast("Write a steer first");
        return;
      }
      return command(selected.root, { type: "steer", campaign: selected.campaign, ticket: sessionTicket, text });
    }
    case "session-copy":
      return copySessionCommand();
    case "session-raw":
      return loadRawLog();
    case "session-reconnect":
      return connectTerminal(sessionStatus?.canAttach ? "attach" : "fork");
    case "fleet-status":
      fleetStatus = target.dataset.status;
      fleetLimit = 200;
      render();
      return syncFleetUrl();
    case "fleet-more":
      fleetLimit += 200;
      return paintFleet();
    case "open-acceptance": {
      dirtyViews.clear();
      view = "acceptance";
      closeDrawer();
      const found = campaignOf(root, campaign);
      if (found) selected = { root: found.root, campaign: found.slug };
      history.replaceState(null, "", selected.campaign ? `#acceptance?campaign=${encodeURIComponent(selected.campaign)}` : "#acceptance");
      return render();
    }
    case "open-campaign": {
      dirtyViews.clear();
      const found = campaignOf(root, campaign);
      if (found) selected = { root: found.root, campaign: found.slug };
      view = "campaign";
      campaignTab = "overview";
      history.replaceState(null, "", `#campaign/${encodeURIComponent(campaign)}`);
      return render();
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
      ticketView = "list";
      ticketKind = "all";
      ticketQuery = "";
      dirtyViews.clear();
      selected = { root: root || null, campaign: campaign || null };
      if (!campaign) {
        view = "fleet";
        campaignTab = "overview";
        history.replaceState(null, "", "#fleet");
      } else if (view === "campaign") {
        history.replaceState(null, "", `#campaign/${encodeURIComponent(campaign)}/${campaignTab}`);
      } else if (view === "settings") {
        view = "campaign";
        campaignTab = "overview";
        history.replaceState(null, "", `#campaign/${encodeURIComponent(campaign)}`);
      } else {
        history.replaceState(null, "", `#${view}?campaign=${encodeURIComponent(campaign)}`);
      }
      return render();
    case "add-ticket":
      return addTicket(root, campaign);
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
    case "retry":
      return command(root, { type: "retry", campaign, ticket });
    case "stop":
      return command(root, { type: "stop", campaign, ticket });
    case "steer-cancel":
      return command(root, { type: "steer.cancel", campaign, ticket });
    case "pause":
      return command(root, { type: "pause", campaign });
    case "resume":
      return command(root, { type: "resume", campaign });
    case "cancel-campaign": {
      if (!confirm("Stop every live run and pause this campaign?")) return;
      return command(root, { type: "cancel", campaign });
    }
    case "archive-campaign": {
      if (!confirm("Archive this campaign? It leaves the board; the branches stay.")) return;
      return command(root, { type: "archive", campaign });
    }
    case "deliver":
      return command(root, { type: "deliver", campaign });
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
    case "approve-campaign":
      return command(root, { type: "approve", campaign });
    case "approve-item":
      return command(root, {
        type: "review.approve",
        campaign,
        item,
        text: "Approved.",
        cleanup: target.dataset.cleanup === "true",
      });
    case "defaults": {
      const scope = target.dataset.scope === "campaign" ? "campaign" : "console";
      const project = root || campaigns()[0]?.root;
      if (!project) return toast("No project registered yet");
      clearAfterLoad.add(scope);
      return command(project, {
        type: "defaults.apply",
        campaign: scope === "campaign" ? campaign : undefined,
        scope,
      });
    }
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
    case "theme-toggle": {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      try {
        localStorage.setItem("orch.theme", next);
      } catch {
        /* storage can be blocked; the theme still changes for this view */
      }
      document.documentElement.dataset.theme = next;
      render();
      return;
    }
    case "text-size":
      localStorage.setItem("orch.textSize", target.dataset.size);
      document.documentElement.style.fontSize = `${target.dataset.size}px`;
      render();
      return;
    case "palette-open":
      return openPalette();
    case "update-check":
      return checkUpdates();
    case "update-install":
      return installUpdate();
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
  }
});

tabsEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (!button) return;
  goView(button.dataset.view);
});

paletteEl?.addEventListener("click", (event) => {
  if (event.target === paletteEl) closePalette();
});
paletteResultsEl?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-palette-index]");
  if (!row) return;
  runPalette(Number(row.dataset.paletteIndex));
});
paletteInput?.addEventListener("input", () => {
  paletteIndex = 0;
  renderPalette();
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette();
    return;
  }
  if (!paletteEl || paletteEl.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closePalette();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    paletteIndex = Math.min(paletteRows.length - 1, paletteIndex + 1);
    renderPalette();
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    paletteIndex = Math.max(0, paletteIndex - 1);
    renderPalette();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    runPalette(paletteIndex);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
  const stripEl = event.target.closest?.(".kanban-card");
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
  if (event.target.closest("#app")) dirtyViews.add(surface());
});

window.addEventListener("hashchange", routeFromHash);

function connect() {
  const events = new URL("/api/events", API_BASE);
  events.searchParams.set("token", token);
  events.searchParams.set("lastId", "0");
  const source = new EventSource(events);
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
  window.addEventListener("resize", () => fitTerminal());
}
