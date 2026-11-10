/* Orchestration panel. No framework, no build step: state in, DOM out. */

const VIEWS = ["inbox", "board", "campaign", "settings"];
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
let view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "inbox";
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
}

const app = document.getElementById("app");
const drawerEl = document.getElementById("drawer");
const connEl = document.getElementById("conn");
const connText = document.getElementById("connText");
const campaignsEl = document.getElementById("campaigns");
const crumbsEl = document.getElementById("crumbs");
const tabsEl = document.getElementById("nav");
const tabCount = document.getElementById("tab-count");
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

async function load({ quiet = false } = {}) {
  try {
    const next = await api("/api/state");
    state = next;
    /* a command the engine refused must not look queued forever; history is
       read silently on the first load so an old refusal is not replayed */
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

function openItems() {
  return campaigns().flatMap((c) => (c.inbox || []).filter((i) => i.status === "open").map((item) => ({ ...item, campaign: c })));
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
  return [...(state?.catalog || [])].sort((a, b) => priceScore(a) - priceScore(b));
}

function modelKey(entry) {
  return `${entry.provider}/${entry.model}`;
}

function draftKey(scope, kind) {
  return `${scope}:${kind}`;
}

function draft(scope, kind, models) {
  const key = draftKey(scope, kind);
  if (!drafts[key]) drafts[key] = (models || []).map((m) => ({ model: m.model, thinking: m.thinking || "medium" }));
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
  const id = adapterFor(scope);
  const spend = spendFor(scope);
  return catalog().filter(
    (row) => (row.adapter || "pi") === id && (spend !== "subscription-only" || row.included !== false),
  );
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

function isFree(row) {
  return Boolean(row.price) && (row.price.input || 0) === 0 && (row.price.output || 0) === 0;
}

function chainEditor(scope, kind, models) {
  const selected = draft(scope, kind, models);
  const freeAllowed = ["research", "chores", "plan"].includes(kind);
  const options = catalogFor(scope).filter((row) => freeAllowed || !isFree(row));
  const chips = selected.length
    ? selected
        .map(
          (entry, index) => `<span class="model-chip"><span class="m">${esc(entry.model)}</span><span class="t">${esc(entry.thinking || "medium")}</span><button class="x" data-act="chain-remove" data-scope="${scope}" data-kind="${esc(kind)}" data-index="${index}" aria-label="Remove ${esc(entry.model)}">×</button></span>`,
        )
        .join("")
    : `<span class="hint">nothing bound${scope === "console" ? ", so these tickets cannot dispatch" : ""}</span>`;
  return `<div class="chain-editor">
      <div class="model-chips">${chips}</div>
      <div class="chain-add">
        <select data-role="model" data-scope="${scope}" data-kind="${esc(kind)}" aria-label="${esc(kind)} model">
          <option value="">choose a model…</option>
          ${options.map((row) => `<option value="${esc(modelKey(row))}">${esc(modelKey(row))} · ${esc(row.context || "?")}${row.images ? " · images" : ""} · ${esc(priceLabel(row))}</option>`).join("")}
        </select>
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

/* --- render --------------------------------------------------------------- */

function render() {
  ensureSelection();
  const items = openItems();
  tabCount.textContent = items.length ? String(items.length) : "";
  signalEl.classList.toggle("alert", items.length > 0);
  footState.textContent = state ? `${campaigns().length} campaign${campaigns().length === 1 ? "" : "s"} · ${state.projects.length} project${state.projects.length === 1 ? "" : "s"}` : "local";
  const theme = document.documentElement.dataset.theme || "dark";
  document.querySelectorAll("[data-act='theme']").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.theme === theme));
  });
  const size = Number(localStorage.getItem("orch.textSize") || 0);
  document.querySelectorAll("[data-act='text-size']").forEach((b) => {
    b.setAttribute("aria-pressed", String(Number(b.dataset.size) === size));
  });

  renderRail();
  renderCrumbs();
  renderTabs();

  if (!state) return;
  if (view === "inbox") app.innerHTML = viewInbox(items);
  else if (view === "board") app.innerHTML = viewBoard();
  else if (view === "campaign") app.innerHTML = viewCampaign();
  else if (view === "settings") app.innerHTML = viewSettings();

  autoSize();
  markFresh();
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
          <dt>Delivery</dt><dd>Work passed its gates and waits for you to take it.</dd>
          <dt>Failure</dt><dd>Attempts ran out, or a merge would not resolve.</dd>
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
          <div class="field"><label for="autoship">Autoship</label><div class="stack">
            <input id="autoship" name="max_autoship_lines" type="number" min="0" value="${c.maxAutoshipLines}" />
            <span class="sub">changed lines above this never ship without you.</span>
          </div></div>
          <div class="field"><label for="bt">Budget</label><div class="stack">
            <div style="display:flex;gap:8px">
              <input id="bt" name="budget_tokens" type="number" min="0" placeholder="tokens" value="${c.budget?.tokens ?? ""}" />
              <input name="budget_dollars" type="number" min="0" step="0.01" placeholder="dollars" value="${c.budget?.dollars ?? ""}" />
            </div>
            <span class="sub">${c.runner?.adapter && c.runner.adapter !== "pi" && c.budget?.dollars ? "A dollar budget cannot cap a subscription adapter; tokens still apply." : "empty: no ceiling."}</span>
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
        <div class="field" style="grid-template-columns:88px 1fr"><label for="t-attachments">Images</label><input id="t-attachments" name="t_attachments" type="text" placeholder="orchestration/<campaign>/attachments/ref.png" /></div>
        <div class="field" style="grid-template-columns:88px 1fr"><label for="t-files">Upload</label><input id="t-files" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple data-role="attach-files" data-target="t_attachments" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" /></div>
      </div>
      <div class="field" style="grid-template-columns:88px 1fr"><label for="t-what">What to build</label><textarea id="t-what" name="t_what" rows="3" placeholder="The end-to-end behaviour, from the user's side."></textarea></div>
      <div class="field" style="grid-template-columns:88px 1fr"><label for="t-accept">Acceptance</label><textarea id="t-accept" name="t_accept" rows="3" placeholder="One checkable outcome per line."></textarea></div>
      <div class="actions" style="margin-top:4px">
        <button class="btn primary" data-act="add-ticket" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}">Add ticket</button>
        <span class="hint">It lands in <span class="mono">orchestration/${esc(c.slug)}/tickets/</span> with the next number.</span>
      </div>
    </details>`;
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
    </div>
    <p class="note" style="margin:8px 0 0">Subscription-only hides metered models; metered-ok shows every discovered model with its price. Changing the adapter changes which catalog the chains below can pick from.</p>
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
    const before = JSON.stringify(kind.models.map((m) => ({ model: m.model, thinking: m.thinking || "medium" })));
    if (kind.overridden || JSON.stringify(models) !== before) kinds[id] = { models };
  }
  clearAfterLoad.add("campaign");
  const patch = {
    autonomy: value("autonomy"),
    plan_gate: value("plan_gate"),
    landing: value("landing"),
    base: value("base"),
    runner: { adapter: value("adapter") || adapterFor("campaign"), spend: value("spend") || "metered-ok" },
    checks,
    allow_paths: value("allow_paths")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    budget: {
      tokens: value("budget_tokens") ? Number(value("budget_tokens")) : null,
      dollars: value("budget_dollars") ? Number(value("budget_dollars")) : null,
    },
    max_autoship_lines: Number(value("max_autoship_lines") || 200),
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
      },
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
    ${t.waitingOn ? `<p class="meta">Waiting for a free lane on ${esc(t.waitingOn)}</p>` : ""}
    <h2>What to build</h2><div class="doc">${esc(t.body || "")}</div>
    <h2>Acceptance</h2><div class="doc">${(t.accepted || []).map((a) => `· ${esc(a.text)}`).join("\n") || "none declared"}</div>
    ${(t.attachments || []).length ? `<h2>Attached images</h2><div class="doc">${(t.attachments || []).map((p) => `· ${esc(p)}`).join("\n")}</div>` : ""}
    ${t.answer ? `<h2>Last answer</h2><div class="doc">${esc(t.answer.text)}${t.answer.citation ? `\n${esc(t.answer.citation)}` : ""}</div>` : ""}
    ${t.findings ? `<h2>Findings</h2><pre class="log">${esc(t.findings)}</pre>` : ""}
    <h2>Runs</h2>
    <table><thead><tr><th>Run</th><th>Role</th><th>Model</th><th>Report</th><th class="num">Cost</th></tr></thead><tbody>
      ${runs
        .map(
          (r) => `<tr><td class="mono" style="font-size:0.76rem" title="${esc(r.id)}">${esc(r.id.replace(/^r-\d{8}T/, ""))}</td><td>${esc(r.role)}</td><td class="mono" style="font-size:0.76rem">${esc(r.model || "")}</td><td>${esc(r.reportStatus || r.status)}${r.killed ? ` (${esc(r.killed)})` : ""}</td><td class="num">${r.unmetered ? "unmetered" : usd(r.dollars)}</td></tr>`,
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
    <div class="field" style="grid-template-columns:5.5rem 1fr"><label>Images</label><input name="e_attachments" type="text" value="${esc((t.attachments || []).join(", "))}" /></div>
    <div class="field" style="grid-template-columns:5.5rem 1fr"><label>Upload</label><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple data-role="attach-files" data-target="e_attachments" data-root="${esc(c.root)}" data-campaign="${esc(c.slug)}" /></div>
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
  if (location.hash.startsWith("#ticket/")) history.replaceState(null, "", `#${view}`);
}

function routeFromHash() {
  const hash = location.hash.slice(1);
  if (hash.startsWith("campaign/")) {
    const slug = decodeURIComponent(hash.slice("campaign/".length));
    const found = campaigns().find((c) => c.slug === slug);
    if (found) selected = { root: found.root, campaign: found.slug };
    view = "campaign";
    render();
    return;
  }
  if (hash.startsWith("ticket/")) {
    const id = decodeURIComponent(hash.slice("ticket/".length));
    if (current() && id) openTicket(current().root, current().slug, id);
    return;
  }
  if (VIEWS.includes(hash) && hash !== view) {
    view = hash;
    closeDrawer();
    render();
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

document.addEventListener("change", (event) => {
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
  const kinds = scope === "console" ? state?.console?.kinds : current()?.effectiveKinds;
  for (const id of Object.keys(kinds || {})) drafts[`${scope}:${id}`] = [];
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
      return command(root, { type: "catalog.refresh", adapter: adapterFor(scope) });
    }
    case "add-ticket":
      return addTicket(root, campaign);
    case "chain-add": {
      const scope = target.dataset.scope;
      const kind = target.dataset.kind;
      const model = document.querySelector(`select[data-role="model"][data-scope="${scope}"][data-kind="${kind}"]`)?.value;
      const thinking = document.querySelector(`select[data-role="thinking"][data-scope="${scope}"][data-kind="${kind}"]`)?.value || "medium";
      if (!model) return toast("Pick a model first");
      const list = draft(scope, kind, []);
      if (list.some((m) => m.model === model)) return toast("Already in the chain");
      list.push({ model, thinking });
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
      const select = document.querySelector(`select[data-role="model"][data-scope="${scope}"][data-kind="${kind}"]`);
      const first = [...(select?.options || [])].find((option) => option.value);
      if (!first) return toast("No model catalog for this adapter");
      const list = draft(scope, kind, []);
      if (list.some((entry) => entry.model === first.value)) return toast("Already in the chain");
      const thinking = document.querySelector(`select[data-role="thinking"][data-scope="${scope}"][data-kind="${kind}"]`)?.value || "medium";
      list.push({ model: first.value, thinking });
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
  history.replaceState(null, "", `#${view}`);
  render();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
  const stripEl = event.target.closest?.(".strip");
  if (stripEl && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openTicket(stripEl.dataset.root, stripEl.dataset.campaign, stripEl.dataset.ticket);
  }
});

document.addEventListener("input", (event) => {
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
