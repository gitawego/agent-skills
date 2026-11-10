// Console defaults, campaign config, the model catalog, and validation.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
    runner: { command: "pi" },
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

// --- catalog ---------------------------------------------------------------

let catalogCache = null;

export function resetCatalog() {
  catalogCache = null;
}

export function catalog({ refresh = false } = {}) {
  if (catalogCache && !refresh) return catalogCache;
  const command = process.env.PI_BIN || "pi";
  const res = spawnSync(command, ["--list-models"], { encoding: "utf8", timeout: 60_000 });
  if (res.status !== 0) {
    throw new UserError(`\`${command} --list-models\` failed`, [
      (res.stderr || res.stdout || "no output").trim(),
      "Fix provider credentials before binding, or set PI_BIN.",
    ]);
  }
  const rows = [];
  for (const line of (res.stdout || "").split("\n")) {
    if (!line.trim() || /^provider\s/.test(line)) continue;
    const cells = line.split(/\s{2,}/).map((c) => c.trim());
    if (cells.length < 4) continue;
    rows.push({
      provider: cells[0],
      model: cells[1],
      context: cells[2],
      maxOut: cells[3],
      thinking: cells[4] === "yes",
      images: cells[5] === "yes",
    });
  }
  catalogCache = rows;
  return rows;
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
  const rows = catalogRows || catalog();

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
      else if (!resolveModel(entry.model, rows))
        errors.push(`model "${entry.model}" in kind "${id}" is not in the catalog; run \`orchestrate catalog\``);
    }
  }

  /* A reviewer that starts on the same model as the work is not a gate. */
  const reviewModel = kinds.review?.models?.[0]?.model;
  if (reviewModel) {
    for (const id of used) {
      if (id === "review") continue;
      const first = kinds[id]?.models?.[0]?.model;
      if (first && first === reviewModel)
        errors.push(`the review chain starts with ${reviewModel}, the same model as kind "${id}"; bind review to a different model`);
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

  return { errors, kinds };
}
