// Console defaults, campaign config, the model catalog, and validation.
import fs from "node:fs";
import path from "node:path";
import {
  UserError,
  consoleFile,
  ensureDir,
  exists,
  readJson,
  readText,
  writeJson,
  isGitRepo,
  git,
} from "./util.mjs";
import { splitFrontmatter } from "./yaml.mjs";
import { listPiModels, resetPiCatalog } from "./pi-catalog.mjs";
import { ADAPTER_IDS, DEFAULT_ADAPTER, DEFAULT_SPEND, SPEND_MODES } from "./adapter-ids.mjs";

export const DEFAULT_KINDS = {
  plan: {
    label: "Plan",
    description: "Planning, decomposition, judging escalations",
    models: [],
    max_concurrent: 1,
    tools: "read,grep,find,ls,bash",
    timeout_min: 30,
  },
  code: {
    label: "Code",
    description: "Backend, tests, code, frontend matching existing style",
    models: [],
    max_concurrent: 2,
    tools: "default",
    timeout_min: 90,
  },
  design: {
    label: "Design",
    description: "Layout, typography, motion, new frontend design",
    models: [],
    max_concurrent: 1,
    tools: "default",
    timeout_min: 90,
  },
  visual: {
    label: "Visual",
    description: "3D, material, rendering, visual adjudication",
    models: [],
    max_concurrent: 1,
    tools: "default",
    timeout_min: 120,
  },
  research: {
    label: "Research",
    description: "Exploration, reading, batching, docs, purely offline verification",
    models: [],
    max_concurrent: 3,
    tools: "read,grep,find,ls,bash,web_search,fetch_content",
    timeout_min: 60,
  },
  review: {
    label: "Review",
    description: "Cold review of a diff against the ticket and the standards",
    models: [],
    max_concurrent: 1,
    tools: "read,grep,find,ls,bash",
    timeout_min: 45,
  },
  chores: {
    label: "Chores",
    description: "Merges, disk cleanup, ops, read-only investigation",
    models: [],
    max_concurrent: 2,
    tools: "default",
    timeout_min: 30,
  },
};

export function defaultConsole() {
  return {
    version: 1,
    panel: { port: 4173, bind: "127.0.0.1" },
    limits: {
      max_concurrent: 4,
      run_timeout_min: 90,
      stuck_after_min: 10,
      max_attempts: 3,
      human_slot_extra: 1,
    },
    kinds: structuredClone(DEFAULT_KINDS),
    runner: { command: "pi", adapter: DEFAULT_ADAPTER },
  };
}

export function ensureConsole() {
  const file = consoleFile();
  if (!exists(file)) {
    ensureDir(path.dirname(file));
    writeJson(file, defaultConsole());
    return { config: readJson(file), created: true };
  }
  return { config: mergeConsole(readJson(file, {})), created: false };
}

function mergeConsole(raw) {
  const base = defaultConsole();
  return {
    ...base,
    ...raw,
    panel: { ...base.panel, ...(raw.panel || {}) },
    limits: { ...base.limits, ...(raw.limits || {}) },
    runner: { ...base.runner, ...(raw.runner || {}) },
    kinds: Object.fromEntries(
      Object.entries({ ...base.kinds, ...(raw.kinds || {}) }).map(([id, kind]) => [
        id,
        { ...DEFAULT_KINDS[id], ...kind, models: kind.models || [] },
      ]),
    ),
  };
}

export function loadConsole() {
  const file = consoleFile();
  if (!exists(file)) throw new UserError(`No console at ${file}`, ["Run `orchestrate init` in a project first."]);
  return mergeConsole(readJson(file, {}));
}

export function saveConsole(config) {
  writeJson(consoleFile(), config);
}

/* Campaign overrides console; absent spend falls back to the adapter default. */
export function runnerConfig(consoleConfig, data = {}) {
  const adapter = data.runner?.adapter || consoleConfig.runner?.adapter || DEFAULT_ADAPTER;
  const spend = data.runner?.spend || consoleConfig.runner?.spend || DEFAULT_SPEND[adapter] || "metered-ok";
  return { adapter, spend, command: consoleConfig.runner?.command || "pi" };
}

/* A chain entry may override the campaign adapter; otherwise it inherits. */
export function entryAdapter(runner, entry = {}) {
  return entry.adapter || runner.adapter;
}

// --- catalog ---------------------------------------------------------------

export function resetCatalog() {
  resetPiCatalog();
}

export function catalog({ refresh = false } = {}) {
  try {
    return listPiModels({ refresh });
  } catch (err) {
    throw new UserError(err.message, [
      err.hint || "Fix provider credentials before binding, or set PI_BIN.",
    ]);
  }
}

export function modelKey(entry) {
  return `${entry.provider}/${entry.model}`;
}

export function resolveModel(model, rows = catalog()) {
  const raw = String(model ?? "").trim();
  if (!raw) return null;
  if (raw.includes("/")) {
    const [provider, ...rest] = raw.split("/");
    const id = rest.join("/");
    return rows.find((r) => r.provider === provider && r.model === id) || null;
  }
  const matches = rows.filter((r) => r.model === raw);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return matches[0];
  return null;
}

// --- campaign --------------------------------------------------------------

const CAMPAIGN_FIELDS = new Set([
  "campaign",
  "stage",
  "autonomy",
  "plan_gate",
  "landing",
  "base",
  "checks",
  "allow_paths",
  "budget",
  "max_autoship_lines",
  "kinds",
  "runner",
]);

const STAGES = new Set(["draft", "awaiting_approval", "running", "paused", "delivered", "archived"]);
const AUTONOMY = new Set(["supervised", "trusted", "unattended"]);

export function campaignFile(root, slug) {
  return path.join(root, "orchestration", slug, "campaign.md");
}

export function listCampaigns(root) {
  const dir = path.join(root, "orchestration");
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && exists(path.join(dir, e.name, "campaign.md")))
    .map((e) => e.name)
    .sort();
}

export function sections(body) {
  const map = {};
  let current = null;
  for (const line of String(body).split("\n")) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      current = m[1].trim().toLowerCase();
      map[current] = [];
      continue;
    }
    if (current) map[current].push(line);
  }
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.join("\n").trim()]));
}

export function readCampaign(root, slug) {
  const file = campaignFile(root, slug);
  const text = readText(file);
  if (text === null) throw new UserError(`No campaign "${slug}" in ${root}`, ["Run `orchestrate status`."]);
  const { data, body } = splitFrontmatter(text);
  return { slug, file, dir: path.dirname(file), text, data, body, sections: sections(body) };
}

export function ticketKindsUsed(tickets) {
  return [...new Set(tickets.map((t) => t.data.kind))].sort();
}

export function resolveKinds(consoleConfig, campaignData) {
  const overrides = campaignData.kinds || {};
  const ids = new Set([...Object.keys(consoleConfig.kinds), ...Object.keys(overrides)]);
  const out = {};
  for (const id of ids) {
    const base = consoleConfig.kinds[id] || DEFAULT_KINDS[id] || {};
    const over = overrides[id] || {};
    out[id] = {
      id,
      label: over.label || base.label || id,
      description: over.description || base.description || "",
      models: (over.models ?? base.models ?? []).map((m) => ({ ...m })),
      max_concurrent: over.max_concurrent ?? base.max_concurrent ?? 1,
      tools: over.tools ?? base.tools ?? "default",
      timeout_min: over.timeout_min ?? base.timeout_min ?? 60,
    };
  }
  return out;
}

export function validateCampaign({ root, consoleConfig, data, tickets = [], catalogRows = null }) {
  const errors = [];
  const runner = runnerConfig(consoleConfig, data);
  if (!ADAPTER_IDS.includes(runner.adapter))
    errors.push(`unknown runner.adapter "${runner.adapter}"; one of ${ADAPTER_IDS.join(", ")}`);
  if (!SPEND_MODES.includes(runner.spend))
    errors.push(`runner.spend must be one of ${SPEND_MODES.join(", ")}`);
  const rowsForAdapter = (adapterId) => {
    if (Array.isArray(catalogRows)) return adapterId === runner.adapter ? catalogRows : adapterId === "pi" ? catalog() : [];
    if (catalogRows && typeof catalogRows === "object") return catalogRows[adapterId] || (adapterId === "pi" ? catalog() : []);
    return adapterId === "pi" ? catalog() : [];
  };
  const rows = rowsForAdapter(runner.adapter);
  if (runner.adapter !== "pi" && !rows.length)
    errors.push(`adapter "${runner.adapter}" has no catalog; run \`orchestrate catalog --adapter ${runner.adapter} --refresh\``);

  if (data.runner != null && (typeof data.runner !== "object" || Array.isArray(data.runner))) {
    errors.push("runner must be an object with adapter and spend");
  }
  for (const key of Object.keys(data)) {
    if (!CAMPAIGN_FIELDS.has(key)) errors.push(`unknown campaign field "${key}"`);
  }
  if (!data.campaign) errors.push("campaign has no name");
  if (data.stage && !STAGES.has(data.stage)) errors.push(`unknown stage "${data.stage}"`);
  if (data.autonomy && !AUTONOMY.has(data.autonomy))
    errors.push(`autonomy must be one of ${[...AUTONOMY].join(", ")}`);
  if (data.plan_gate && !["human", "auto"].includes(data.plan_gate))
    errors.push('plan_gate must be "human" or "auto"');
  if (data.landing && !["branch", "directory"].includes(data.landing))
    errors.push('landing must be "branch" or "directory"');

  const landing = data.landing || "branch";
  if (landing === "branch") {
    if (!isGitRepo(root)) errors.push("landing: branch needs a git repository");
    const base = data.base || "main";
    if (isGitRepo(root) && !git(root, ["rev-parse", "--verify", "--quiet", base]).ok)
      errors.push(`base ref "${base}" does not exist`);
  }

  if (data.allow_paths != null && !Array.isArray(data.allow_paths)) {
    errors.push("allow_paths must be a list of globs");
  }
  for (const check of data.checks || []) {
    if (!check || !check.name) errors.push("a check needs a name");
    if (!check || !check.cmd) errors.push(`check "${check?.name || "?"}" has no command`);
  }

  for (const ticket of tickets) {
    const list = ticket?.data?.attachments;
    const files = list == null ? [] : Array.isArray(list) ? list : [list];
    for (const file of files) {
      const abs = path.resolve(root, String(file));
      const rel = path.relative(root, abs);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        errors.push(`${ticket.data.id}: attachment "${file}" is outside the project`);
      } else if (!exists(abs)) {
        errors.push(`${ticket.data.id}: attachment "${file}" does not exist`);
      }
    }
  }

  const limits = consoleConfig.limits;
  if (data.max_autoship_lines != null && !Number.isInteger(data.max_autoship_lines))
    errors.push("max_autoship_lines must be an integer");

  const kinds = resolveKinds(consoleConfig, data);
  for (const [id, kind] of Object.entries(data.kinds || {})) {
    if (!DEFAULT_KINDS[id] && !consoleConfig.kinds[id]) errors.push(`unknown ticket kind "${id}"`);
    if (kind.max_concurrent != null) {
      if (!Number.isInteger(kind.max_concurrent) || kind.max_concurrent < 1)
        errors.push(`kind "${id}" max_concurrent must be a positive integer`);
      else if (kind.max_concurrent > limits.max_concurrent)
        errors.push(`kind "${id}" max_concurrent ${kind.max_concurrent} exceeds the console cap ${limits.max_concurrent}`);
    }
    if (kind.timeout_min != null && kind.timeout_min > limits.run_timeout_min * 2)
      errors.push(`kind "${id}" timeout_min ${kind.timeout_min} is beyond twice the console run timeout`);
  }

  const used = ticketKindsUsed(tickets);
  const declared = Object.keys(data.kinds || {}).filter((id) => (kinds[id]?.models || []).length);
  /* every ready ticket passes a review run, so that chain must exist before dispatch */
  const gateKinds = ["review"];
  const checked = [...new Set([...used, ...declared, ...gateKinds])];
  for (const id of used) {
    if (!kinds[id]) errors.push(`ticket kind "${id}" is not defined`);
  }
  for (const id of gateKinds) {
    if (!kinds[id]) errors.push(`kind "${id}" is not defined, and every ticket needs it at the gate`);
  }
  for (const id of checked) {
    const kind = kinds[id];
    if (!kind) continue;
    if (!kind.models.length) errors.push(`kind "${id}" has no model chain; bind one with \`orchestrate bind\``);
    if (kind.tools !== "default") {
      const tools = String(kind.tools).split(",").map((t) => t.trim());
      if (!tools.includes("bash") && !tools.includes("write"))
        errors.push(`kind "${id}" has no tool that can write a report; add bash or write to its tools`);
    }
    for (const entry of kind.models) {
      if (!entry.model) errors.push(`kind "${id}" has a chain entry without a model`);
      else {
        const adapterId = entry.adapter || runner.adapter;
        const entryRows = rowsForAdapter(adapterId);
        const resolved = resolveModel(entry.model, entryRows);
        if (!resolved) {
          errors.push(`model "${entry.model}" in kind "${id}" is not in the catalog for adapter "${adapterId}"; run \`orchestrate catalog --adapter ${adapterId}\``);
        } else if (resolved.adapter && resolved.adapter !== adapterId) {
          errors.push(`model "${entry.model}" belongs to adapter "${resolved.adapter}", but the entry is bound to "${adapterId}"`);
        } else if (runner.spend === "subscription-only" && resolved.included === false) {
          errors.push(`model "${entry.model}" is not included in the ${adapterId} subscription; set runner.spend: metered-ok to allow it`);
        } else if (["code", "design", "visual", "review"].includes(id) && resolved.price && (resolved.price.input === 0 && resolved.price.output === 0)) {
          errors.push(`model "${entry.model}" is free/promo and not allowed for kind "${id}"; bind a paid or self-hosted model`);
        }
      }
    }
  }

  /* A reviewer that starts on the same model as the work is not a gate. */
  const reviewEntry = kinds.review?.models?.[0];
  if (reviewEntry?.model) {
    const reviewAdapter = reviewEntry.adapter || runner.adapter;
    for (const id of used) {
      if (id === "review") continue;
      const first = kinds[id]?.models?.[0];
      if (!first?.model) continue;
      const firstAdapter = first.adapter || runner.adapter;
      if (firstAdapter === reviewAdapter && first.model === reviewEntry.model)
        errors.push(`the review chain starts with ${reviewAdapter}/${reviewEntry.model}, the same model as kind "${id}"; bind review to a different model`);
    }
  }

  const budget = data.budget || {};
  const consoleBudget = consoleConfig.limits.budget || {};
  for (const unit of ["tokens", "dollars"]) {
    if (budget[unit] == null) continue;
    if (typeof budget[unit] !== "number" || budget[unit] <= 0)
      errors.push(`budget ${unit} must be a positive number`);
    if (consoleBudget[unit] != null && budget[unit] > consoleBudget[unit])
      errors.push(`budget ${unit} ${budget[unit]} exceeds the console ceiling ${consoleBudget[unit]}`);
  }
  if (budget.dollars && !budget.ack_unmetered) {
    const unmetered = Object.values(kinds).some((kind) =>
      (kind.models || []).some((entry) => (entry.adapter || runner.adapter) !== "pi"),
    );
    if (unmetered)
      errors.push("budget.dollars cannot cap a subscription adapter; set budget.ack_unmetered: true to approve that");
  }

  return { errors, kinds, runner, rows };
}
