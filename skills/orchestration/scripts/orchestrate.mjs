#!/usr/bin/env node
// The orchestration CLI. Every verb is also a panel command; both write the same queue.
import fs from "node:fs";
import path from "node:path";
import { spawn as spawnDetached } from "node:child_process";
import {
  UserError,
  binHome,
  dataHome,
  campaignPlanDir,
  ensureDir,
  exists,
  git,
  isGitRepo,
  nowIso,
  registryFile,
  readJson,
  readText,
  writeJson,
  consoleFile,
  consoleStateDir,
  exists as fileExists,
  globalPanelFile,
  panelToken,
  pidAlive,
} from "./lib/util.mjs";
import {
  catalog,
  ensureConsole,
  listCampaigns,
  loadConsole,
  readCampaign,
  resolveKinds,
  resolveModel,
  runnerConfig,
  saveConsole,
  ticketKindsUsed,
} from "./lib/config.mjs";
import { boundFirstModels, pendingDefaultKinds, resolveDefaultChains } from "./lib/defaults.mjs";
import { appendContext, importPlan, parsePlanText, readContext } from "./lib/plan-import.mjs";
import {
  deriveAppliedAudit,
  discardDraft,
  draftPlan,
  canonicalText,
  formatPlanDiff,
  appliedAuditFile,
  persistAppliedAudit,
  readAppliedBase,
  readAppliedAudit,
  readDraft,
  refreshDraft,
  writeApplied,
} from "./lib/plan-draft.mjs";
import { refreshCatalog, rowsFor, adaptersView } from "./lib/catalogs.mjs";
import { ADAPTER_IDS, DEFAULT_SPEND, SPEND_MODES } from "./lib/adapter-ids.mjs";
import { bwrapAvailable } from "./lib/sandbox.mjs";
import { asArray, loadPlan, ticketTitle } from "./lib/plan.mjs";
import { decisionsFor, promoteDecision, readDecisions, summaryLine } from "./lib/memory.mjs";
import { appendEvent, readEvents } from "./lib/ledger.mjs";
import { diffStats, integrationBranch } from "./lib/landing.mjs";
import { priceLabel } from "./lib/pricing.mjs";
import { approveCampaign, tick } from "./lib/engine.mjs";
import { enqueue } from "./lib/commands.mjs";
import { listItems } from "./lib/inbox.mjs";
import { campaignView, projectView } from "./lib/view.mjs";
import { startServer } from "./lib/server.mjs";
import { loadDispatch, setDispatch } from "./lib/dispatch.mjs";
import { validateQuotas } from "./lib/quotas.mjs";
import { joinFrontmatter } from "./lib/yaml.mjs";
import { addTicket, createCampaign, ensureGitignore } from "./lib/create.mjs";
import { loadState } from "./lib/state.mjs";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=");
      if (inline != null) {
        flags[key] = inline;
      } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function rootDir(flags) {
  return path.resolve(flags.root || process.env.ORCH_PROJECT || process.cwd());
}

function registryAdd(root) {
  const file = registryFile();
  const registry = readJson(file, { version: 1, projects: [] });
  const projects = registry.projects.filter((p) => p.path !== root);
  projects.push({ path: root, name: path.basename(root), registeredAt: nowIso() });
  writeJson(file, { version: 1, projects });
  return projects;
}

function registryRoots() {
  const file = registryFile();
  const registry = readJson(file, { version: 1, projects: [] });
  return (registry.projects || []).map((p) => p.path).filter((p) => exists(p));
}

function nearestProject(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fileExists(path.join(dir, ".orchestration"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveCampaign(root, explicit) {
  const slugs = listCampaigns(root);
  if (explicit && explicit !== true) {
    if (!slugs.includes(explicit)) throw new UserError(`No campaign "${explicit}"`, slugs.map((s) => `  ${s}`));
    return explicit;
  }
  if (slugs.length === 1) return slugs[0];
  if (!slugs.length) throw new UserError("This project has no campaign", ["Run `orchestrate start \"<goal>\"`."]);
  throw new UserError("Several campaigns exist; pass one", slugs.map((s) => `  ${s}`));
}

function findItem(root, id) {
  for (const slug of listCampaigns(root)) {
    const item = listItems(root, slug).find((i) => i.id === id || i.id.startsWith(id));
    if (item) return { slug, item };
  }
  return null;
}

function tickNow(root, { quiet = false } = {}) {
  const result = tick({ root });
  if (!quiet) {
    for (const row of result.results) {
      if (row.error) {
        console.error(`${row.slug}: ${row.error}`);
        continue;
      }
      console.log(`${row.slug} [${row.stage}] ` + row.tickets.map((t) => `${t.id}:${t.stage}`).join("  "));
    }
  }
  return result;
}

function money(value) {
  const n = Number(value || 0);
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/* A new console starts bound when the adapter's catalog already knows the
   default families. An existing console is never rewritten by init: a chain a
   person cleared stays cleared until `orchestrate defaults --apply` says so. */
function seedConsoleDefaults({ root, config }) {
  const bound = Object.values(config.kinds || {}).some((kind) => (kind.models || []).length);
  if (bound) return { applied: [], warnings: [] };
  const runner = runnerConfig(config, {});
  let rows = [];
  try {
    rows = rowsFor(runner.adapter, root);
  } catch {
    return { applied: [], warnings: [] };
  }
  if (!rows.length) return { applied: [], warnings: [] };
  const resolved = resolveDefaultChains({ rows, adapter: runner.adapter, spend: runner.spend });
  const applied = [];
  for (const [kind, chain] of Object.entries(resolved.chains)) {
    if (!config.kinds[kind]) continue;
    config.kinds[kind].models = chain.models;
    applied.push(kind);
  }
  if (applied.length) saveConsole(config);
  return { applied, warnings: resolved.warnings };
}

function printTickets(root, slug) {
  const plan = loadPlan(root, slug);
  const state = loadState(root, slug);
  const rows = plan.ordered.map((ticket) => {
    const entry = state.tickets[ticket.data.id] || {};
    return {
      id: ticket.data.id,
      stage: entry.stage || "-",
      kind: ticket.data.kind,
      blocked_by: (ticket.data.blocked_by || []).join(",") || "-",
      title: ticketTitle(ticket),
    };
  });
  if (rows.length) {
    const width = Math.max(...rows.map((r) => r.title.length), 5);
    for (const row of rows) {
      console.log(
        `${row.id}  ${row.stage.padEnd(14)} ${row.kind.padEnd(9)} blocked:${String(row.blocked_by).padEnd(8)} ${row.title.padEnd(width)}`,
      );
    }
  }
  const draft = readDraft(root, slug);
  for (const error of plan.errors) {
    if (draft.exists && /no tickets/i.test(error)) continue;
    console.log(`  ! ${error}`);
  }
  return plan;
}

const commands = {
  init({ flags }) {
    const root = rootDir(flags);
    ensureDir(path.join(root, ".orchestration"));
    ensureDir(path.join(root, "orchestration"));
    ensureGitignore(root);
    registryAdd(root);
    const { config, created } = ensureConsole();
    console.log(`project   ${root}`);
    console.log(`state     ${path.join(root, ".orchestration")}`);
    console.log(`console   ${consoleFile()}${created ? " (created)" : ""}`);
    const adapters = adaptersView();
    const total = adapters.reduce((n, a) => n + (a.models || 0), 0);
    console.log(`adapters  ${adapters.map((a) => `${a.id}${a.models ? ` (${a.models})` : ""}`).join(", ")} — ${total} models`);
    if (created) {
      const pi = adapters.find((a) => a.id === "pi");
      const installed = adapters.find((a) => a.id !== "pi" && a.adapterVersion);
      if ((!pi || !pi.models) && installed) {
        config.runner = { ...config.runner, adapter: installed.id };
        saveConsole(config);
        console.log(`adapter   defaulted to ${installed.id} (no pi catalog found)`);
      }
      const seeded = seedConsoleDefaults({ root, config });
      if (seeded.applied.length) {
        console.log(`chains    defaulted ${seeded.applied.join(", ")} to the newest catalogue release`);
      }
      for (const warning of seeded.warnings) console.log(`chains    ${warning}`);
    }
    console.log(`catalog   set the adapter with \`orchestrate adapter <id>\`, then refresh it in the panel`);
    console.log("");
    console.log('Next: orchestrate start "<goal>"');
  },

  adapter({ flags, positional }) {
    const id = positional[0];
    if (!ADAPTER_IDS.includes(id)) throw new UserError(`unknown adapter "${id}"`, [`one of ${ADAPTER_IDS.join(", ")}`]);
    const spend = flags.spend;
    if (spend && !SPEND_MODES.includes(spend)) throw new UserError(`unknown spend mode "${spend}"`);
    const config = loadConsole();
    config.runner = { ...config.runner, adapter: id, ...(spend ? { spend } : {}) };
    saveConsole(config);
    console.log(`console adapter: ${id}${spend ? ` (${spend})` : ""}`);
  },

  catalog({ flags, positional }) {
    const root = rootDir(flags);
    const adapter = flags.adapter || loadConsole().runner?.adapter || "pi";
    if (flags.refresh) {
      try {
        refreshCatalog(adapter, { cwd: root });
      } catch (err) {
        throw new UserError(`adapter "${adapter}" could not discover models`, [
          err.message,
          err.hint || "Check that the harness is installed and signed in.",
        ]);
      }
    }
    const rows = adapter === "pi" ? catalog() : rowsFor(adapter, root);
    if (!rows.length) {
      throw new UserError(`no catalog for adapter "${adapter}"`, [
        `Run \`orchestrate catalog --adapter ${adapter} --refresh\` once.`,
      ]);
    }
    const search = (positional[0] || "").toLowerCase();
    const list = rows.filter((r) => !search || `${r.provider}/${r.model}`.toLowerCase().includes(search));
    if (flags.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`${pad("model", 44)} ${pad("context", 10)} ${pad("out", 8)} think  images  price`);
    for (const row of list) {
      console.log(
        `${pad(`${row.provider}/${row.model}`, 44)} ${pad(row.context || "?", 10)} ${pad(row.maxOut || "?", 8)} ${row.thinking ? "yes" : "no "}    ${row.images == null ? "?" : row.images ? "yes" : "no"}     ${priceLabel(row)}`,
      );
    }
  },

  adapters({ flags }) {
    const rows = adaptersView();
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`${pad("adapter", 16)} ${pad("version", 12)} ${pad("models", 8)} fetched`);
    for (const row of rows) {
      console.log(`${pad(row.id, 16)} ${pad(row.adapterVersion || "?", 12)} ${pad(String(row.models), 8)} ${row.fetchedAt || "not discovered"}`);
    }
  },

  doctor({ flags }) {
    const root = rootDir(flags);
    let rows = adaptersView();
    const problems = [];
    if (flags.refresh) {
      for (const row of rows) {
        if (!row.adapterVersion) continue;
        try {
          refreshCatalog(row.id, { cwd: root });
        } catch (err) {
          problems.push(`${row.id}: live discovery failed: ${err.message}`);
        }
      }
      rows = adaptersView();
    }
    for (const row of rows) {
      if (!row.adapterVersion) problems.push(`${row.id}: harness not found`);
      if (!row.models) problems.push(`${row.id}: no catalog; run \`orchestrate catalog --adapter ${row.id} --refresh\``);
      else if (row.stale) problems.push(`${row.id}: catalog is stale; refresh it`);
    }
    for (const row of rows) {
      const state = !row.adapterVersion ? "missing" : !row.models ? "no catalog" : row.stale ? "stale" : "ok";
      console.log(`${row.id.padEnd(16)} ${state.padEnd(11)} ${row.adapterVersion || "?"} ${row.models || 0} models`);
    }
    console.log(`sandbox          ${bwrapAvailable() ? "bwrap available" : "path guard only (bwrap unavailable)"}`);
    if (problems.length) {
      for (const problem of problems) console.error(`- ${problem}`);
      process.exitCode = 1;
    } else {
      console.log("all adapters ready");
    }
  },

  start({ flags, positional }) {
    const root = rootDir(flags);
    const goal = positional.join(" ").trim();
    if (!goal) throw new UserError('Give the campaign a goal: orchestrate start "<goal>"');
    ensureConsole();
    registryAdd(root);
    const created = createCampaign({
      root,
      goal,
      slug: flags.campaign,
      autonomy: flags.autonomy,
      planGate: flags["plan-gate"],
      landing: flags.landing,
      base: flags.base,
    });
    const self = process.argv[1];
    console.log(created.file);
    console.log("");
    console.log("Next: fill the form, add tickets under tickets/, then");
    console.log(`  node ${self} catalog`);
    console.log(`  node ${self} defaults ${created.slug} --apply   # or bind each kind by hand`);
    console.log(`  node ${self} approve ${created.slug}`);
  },

  ticket({ flags, positional }) {
    const root = rootDir(flags);
    const [sub, ...rest] = positional;
    const slug = resolveCampaign(root, flags.campaign);
    if (sub === "add") {
      const created = addTicket({
        root,
        slug,
        title: rest.join(" ").trim(),
        kind: flags.kind || "code",
        blockedBy: flags["blocked-by"],
        touches: flags.touches,
        attachments: flags.attachments,
        what: flags.what,
        criteria: flags.accept,
      });
      console.log(`${created.id}  ${created.title}  (${created.kind})`);
      console.log(created.file);
      return;
    }
    if (sub === "edit" || sub === "remove") {
      const id = rest[0] || flags.ticket;
      if (!id) throw new UserError(`Usage: orchestrate ticket ${sub} <id> [--title ...] [--kind ...] [--touches ...] [--blocked-by ...] [--what ...] [--accept ...]`);
      if (sub === "remove") {
        enqueue(root, { type: "ticket.remove", campaign: slug, ticket: id });
        console.log(`removed ${id}`);
        tickNow(root);
        return;
      }
      const patch = {};
      if (flags.title) patch.title = flags.title;
      if (flags.kind) patch.kind = flags.kind;
      if (flags.touches) patch.touches = flags.touches;
      if (flags["blocked-by"] !== undefined) patch.blocked_by = flags["blocked-by"];
      if (flags.attachments !== undefined) patch.attachments = flags.attachments;
      if (flags.what) patch.what = flags.what;
      if (flags.accept) patch.criteria = flags.accept;
      if (!Object.keys(patch).length) throw new UserError("Nothing to change: pass --title, --kind, --touches, --blocked-by, --what or --accept");
      enqueue(root, { type: "ticket.edit", campaign: slug, ticket: id, patch });
      console.log(`edited ${id}: ${Object.keys(patch).join(", ")}`);
      tickNow(root);
      return;
    }
    throw new UserError("Usage: orchestrate ticket add|edit|remove ...");
  },

  cancel({ flags, positional }) {
    const root = rootDir(flags);
    const slug = resolveCampaign(root, flags.campaign || positional[0]);
    enqueue(root, { type: "cancel", campaign: slug, reason: flags.reason || "cancelled by a person" });
    tickNow(root);
  },

  archive({ flags, positional }) {
    const root = rootDir(flags);
    const slug = resolveCampaign(root, flags.campaign || positional[0]);
    enqueue(root, { type: "archive", campaign: slug });
    tickNow(root);
  },

  context({ flags, positional }) {
    const root = rootDir(flags);
    if (positional[0] === "append") {
      const slug = resolveCampaign(root, positional[1] || flags.campaign);
      let text = flags.text;
      if (!text && flags.from) {
        text = flags.from === "-" ? fs.readFileSync(0, "utf8") : readText(path.resolve(root, flags.from), null);
        if (text == null) throw new UserError(`No context file at ${flags.from}`);
      }
      if (!text) throw new UserError('Usage: orchestrate context append <campaign> --from notes.md | --text "..."');
      const result = appendContext({ root, slug, text, source: flags.source || "human" });
      console.log(`context ${slug}: ${result.bytes} bytes appended (${result.total} total)`);
      console.log(result.file);
      return;
    }
    const slug = flags.campaign || process.env.ORCH_CAMPAIGN || resolveCampaign(root, undefined);
    const campaign = readCampaign(root, slug);
    const plan = loadPlan(root, slug);
    const state = loadState(root, slug);
    const rawId = flags.ticket || process.env.ORCH_TICKET || positional[0] || "";
    const ticket = rawId ? plan.byId.get(String(rawId).padStart(2, "0")) : null;
    const touches = ticket ? asArray(ticket.data.touches) : [];
    const decisions = decisionsFor(root, slug, touches);
    const siblings = plan.ordered
      .filter((entry) => entry.data.id !== ticket?.data.id)
      .map((entry) => ({
        id: entry.data.id,
        title: ticketTitle(entry),
        stage: state.tickets[entry.data.id]?.stage || "queued",
        summary: state.tickets[entry.data.id]?.summary || "",
      }));
    const events = readEvents(root).filter((event) => event.campaign === slug).slice(-8);
    const stats = (campaign.data.landing || "branch") === "branch" ? diffStats(root, slug, campaign.data.base || "main") : null;

    if (flags.json) {
      console.log(JSON.stringify({ campaign: slug, ticket: ticket?.data.id || null, decisions, siblings, stats, events }, null, 2));
      return;
    }
    const out = [];
    out.push(`# ${slug}`, "");
    out.push((campaign.sections.goal || "").trim(), "");
    if (ticket) {
      out.push(`## Ticket ${ticket.data.id} · ${ticketTitle(ticket)}`, "");
      out.push(ticket.what.trim(), "");
      out.push("Acceptance:");
      out.push(ticket.criteria.map((c) => `- ${c.text}`).join("\n") || "- none declared", "");
      out.push(`Paths: ${touches.join(", ") || "none declared"}`);
      const blockers = asArray(ticket.data.blocked_by);
      if (blockers.length) out.push(`Blocked by: ${blockers.join(", ")}`);
      out.push("");
    }
    out.push("## Decisions", "");
    out.push(decisions.length ? decisions.map((record) => `- ${summaryLine(record)}`).join("\n") : "- none yet", "");
    out.push("## Other tickets", "");
    out.push(
      siblings.length
        ? siblings.map((row) => `- ${row.id} [${row.stage}] ${row.title}${row.summary ? ` — ${row.summary.split("\n")[0].slice(0, 120)}` : ""}`).join("\n")
        : "- none",
      "",
    );
    if (stats) out.push("## Integration branch", "", `${stats.added} added, ${stats.removed} removed against ${campaign.data.base || "main"} (${integrationBranch(slug)})`, "");
    out.push("## Recent history", "");
    out.push(events.length ? events.map((event) => `- ${event.ts.slice(11, 19)} ${event.ticket ? `${event.ticket} ` : ""}${event.type}`).join("\n") : "- nothing yet", "");
    out.push("## Checks", "", (campaign.data.checks || []).map((c) => `- ${c.name}: ${c.cmd}`).join("\n") || "- none declared", "");
    console.log(out.join("\n"));
  },

  decisions({ flags, positional }) {
    const root = rootDir(flags);
    const slugs = positional[0] ? [resolveCampaign(root, positional[0])] : listCampaigns(root);
    const rows = slugs.flatMap((slug) =>
      readDecisions(root, slug, { includeSuperseded: Boolean(flags.all) }).map((record) => ({ ...record, slug })),
    );
    if (flags.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (!rows.length) {
      console.log("no decisions recorded yet");
      return;
    }
    for (const row of rows) {
      console.log(`${row.id}  ${row.scope === "console" ? "console" : row.slug}  ${row.by}${row.ticket ? ` · ${row.ticket}` : ""}`);
      console.log(`  ${row.text}`);
      if (row.cite) console.log(`  ${row.cite}`);
      if (row.supersededBy) console.log(`  superseded by ${row.supersededBy}`);
    }
  },

  promote({ flags, positional }) {
    const root = rootDir(flags);
    const slug = resolveCampaign(root, flags.campaign || positional[1]);
    const id = positional[0];
    if (!id) throw new UserError("Usage: orchestrate promote <decision-id> [campaign]");
    const promoted = promoteDecision(root, slug, id);
    if (!promoted) throw new UserError(`No decision "${id}" in ${slug}`, ["orchestrate decisions <campaign>"]);
    console.log(`promoted ${id} to the console log`);
    console.log(`  ${promoted.text}`);
  },

  plan({ flags, positional }) {
    const root = rootDir(flags);
    const subcommands = new Set(["draft", "diff", "show", "discard", "import", "audit"]);
    const sub = subcommands.has(positional[0]) ? positional[0] : null;
    const slug = resolveCampaign(root, (sub ? positional[1] : positional[0]) || flags.campaign);
    const campaign = readCampaign(root, slug);
    const consoleConfig = loadConsole();
    const kinds = resolveKinds(consoleConfig, campaign.data);
    const allowedKinds = Object.keys(kinds);
    const context = readContext(root, slug);
    const maxConcurrent = Number(consoleConfig.limits?.max_concurrent || 4);
    const planInputs = { allowedKinds, maxConcurrent, contextBytes: context.bytes };

    const editable = () => {
      const state = loadState(root, slug);
      const live = Object.values(state.runs || {}).some((run) => run.status === "live");
      const blockedStages = ["running", "delivered", "archived"];
      const stage = blockedStages.includes(campaign.data.stage) ? campaign.data.stage : state.stage;
      if (live || blockedStages.includes(state.stage) || blockedStages.includes(campaign.data.stage)) {
        throw new UserError(`Campaign "${slug}" is ${live ? "live" : stage}; the plan may change only while it is draft, awaiting approval or paused`, [
          `Pause it first: orchestrate pause ${slug}`,
          "plan draft and plan import never change a plan under a live run.",
        ]);
      }
      return state;
    };

    const printRows = (rows) => {
      const pad = (value, n) => String(value).padEnd(n);
      console.log(`${pad("#", 4)} ${pad("key", 18)} ${pad("kind", 9)} ${pad("blocked", 12)} title`);
      for (const row of rows) {
        console.log(
          `${pad(row.id || "—", 4)} ${pad(row.key, 18)} ${pad(row.kind, 9)} ${pad(row.blocked || "—", 12)} ${row.title}`,
        );
      }
    };

    if (sub === "audit") {
      const stored = readAppliedAudit(root, slug);
      const state = loadState(root, slug);
      const audit = stored || deriveAppliedAudit(root, slug, { appliedAt: state.approvedAt || null });
      if (!audit) throw new UserError(`No applied plan for "${slug}"`, ["Nothing has been imported yet."]);
      if (flags.write) persistAppliedAudit(root, slug, audit);
      if (flags.json) {
        console.log(JSON.stringify(audit, null, 2));
        return;
      }
      console.log(`${slug} · ${(audit.tickets || []).length} tickets · ${audit.hash || "hash unknown"}`);
      console.log(`applied   ${audit.appliedAt || "unknown"}${audit.derived ? " (derived from tickets)" : ""}`);
      for (const ticket of audit.tickets || []) console.log(`  ${ticket.id}  ${ticket.key.padEnd(18)} ${ticket.kind.padEnd(9)} ${ticket.title}`);
      if (audit.assumptions?.length) {
        console.log("assumptions");
        for (const item of audit.assumptions) console.log(`  - ${item}`);
      }
      if (audit.openQuestions?.length) {
        console.log("open questions");
        for (const item of audit.openQuestions) console.log(`  - ${item}`);
      }
      if (flags.write) console.log(`wrote ${appliedAuditFile(root, slug)}`);
      return;
    }

    if (sub === "draft") {
      editable();
      const file = flags.file || (flags.stdin ? "-" : null);
      if (!file) throw new UserError("Usage: orchestrate plan draft <campaign> --file plan.yml | --stdin");
      const text = file === "-" ? fs.readFileSync(0, "utf8") : readText(path.resolve(root, file), null);
      if (text == null) throw new UserError(`No plan file at ${file}`);
      const result = draftPlan({ root, slug, plan: parsePlanText(text), ...planInputs });
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`draft ${result.file}`);
      printRows(result.plan.tickets.map((ticket) => ({ key: ticket.key, kind: ticket.kind, blocked: ticket.blocked_by.join(","), title: ticket.title })));
      console.log("");
      console.log(formatPlanDiff(result));
      console.log("");
      console.log("Nothing is applied. tickets/ is untouched until `orchestrate plan import`.");
      return;
    }

    if (sub === "diff") {
      const result = refreshDraft(root, slug, planInputs);
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printRows(result.plan.tickets.map((ticket) => ({ key: ticket.key, kind: ticket.kind, blocked: ticket.blocked_by.join(","), title: ticket.title })));
      console.log("");
      console.log(formatPlanDiff(result));
      return;
    }

    if (sub === "show") {
      if (flags.applied) {
        const applied = readAppliedBase(root, slug);
        if (!applied.plan) throw new UserError(`No applied plan for "${slug}"`);
        if (flags.json) {
          console.log(JSON.stringify(applied.plan, null, 2));
          return;
        }
        console.log(applied.text || canonicalText(applied.plan));
        return;
      }
      const draft = readDraft(root, slug, { allowedKinds, strict: true });
      if (!draft.exists) throw new UserError(`No draft plan for "${slug}"`, [`Run \`orchestrate plan draft ${slug} --file plan.yml\`.`]);
      const ticketKey = flags.ticket ? String(flags.ticket) : null;
      if (ticketKey) {
        const ticket = draft.plan.tickets.find((entry) => entry.key === ticketKey);
        if (!ticket) throw new UserError(`No ticket "${ticketKey}" in the draft`);
        if (flags.json) {
          console.log(JSON.stringify(ticket, null, 2));
          return;
        }
        console.log(`# ${ticket.title}`);
        console.log(`key:        ${ticket.key}`);
        console.log(`kind:       ${ticket.kind}`);
        console.log(`blocked by: ${ticket.blocked_by.join(", ") || "—"}`);
        console.log(`touches:    ${ticket.touches.join(", ")}`);
        console.log(`sources:    ${ticket.sources.join(", ") || "—"}`);
        console.log("");
        console.log("What to build:");
        console.log(ticket.what);
        console.log("");
        console.log("Acceptance:");
        for (const criterion of ticket.accept) console.log(`- [ ] ${criterion}`);
        if (ticket.notes) {
          console.log("");
          console.log("Notes:");
          console.log(ticket.notes);
        }
        return;
      }
      if (flags.json) {
        console.log(JSON.stringify(draft.plan, null, 2));
        return;
      }
      console.log(draft.text);
      return;
    }

    if (sub === "discard") {
      editable();
      const removed = discardDraft(root, slug);
      console.log(removed.length ? `discarded:\n${removed.join("\n")}` : "no draft to discard");
      return;
    }

    if (sub === "import") {
      if (flags.force)
        throw new UserError("plan import does not accept --force", [
          `Pause the campaign first: orchestrate pause ${slug}`,
        ]);
      const state = editable();
      const acceptOpen = Boolean(flags["accept-open"]);
      let plan;
      if (flags.file || flags.stdin) {
        const file = flags.file || "-";
        const text = file === "-" ? fs.readFileSync(0, "utf8") : readText(path.resolve(root, file), null);
        if (text == null) throw new UserError(`No plan file at ${file}`);
        plan = parsePlanText(text);
      } else {
        const draft = readDraft(root, slug, { allowedKinds, strict: true });
        if (!draft.exists) throw new UserError(`No draft plan for "${slug}"`, [`Write a draft first: orchestrate plan draft ${slug} --file plan.yml`]);
        plan = draft.plan;
      }
      const canRemove = (id) => !Object.values(state.runs || {}).some((run) => String(run.ticket) === String(id));
      const result = importPlan({ root, slug, plan, allowedKinds, prune: Boolean(flags.prune), canRemove, acceptOpen });
      const audit = writeApplied({ root, slug, plan: result.plan, result });
      discardDraft(root, slug);
      appendEvent(root, {
        campaign: slug,
        type: "plan.applied",
        data: { hash: audit.hash, tickets: audit.tickets.length, openQuestions: audit.openQuestions.length },
      });
      if (flags.json) {
        console.log(JSON.stringify({ ...result, audit }, null, 2));
        return;
      }
      printRows(
        result.tickets.map((ticket) => ({
          id: ticket.id,
          key: ticket.key,
          kind: ticket.kind,
          blocked: ticket.blocked_by.join(","),
          title: ticket.title,
        })),
      );
      console.log("");
      console.log(
        `${result.tickets.length} tickets · ${result.created.length} new · ${result.updated.length} updated${result.removed.length ? ` · ${result.removed.length} removed` : ""}`,
      );
      console.log(`plan    ${result.file}`);
      console.log(`audit   ${audit.hash} · ${audit.appliedAt}`);
      if (context.bytes) console.log(`context ${context.file} (${context.bytes} bytes)`);
      console.log(`next    orchestrate defaults ${slug} --apply   # bind chains if the plan has none`);
      console.log(`        orchestrate approve ${slug}`);
      return;
    }

    const plan = loadPlan(root, slug);
    if (flags.json) {
      const audit = readAppliedAudit(root, slug) || deriveAppliedAudit(root, slug, { appliedAt: loadState(root, slug).approvedAt || null });
      console.log(
        JSON.stringify(
          {
            campaign: slug,
            tickets: plan.ordered.map((entry) => ({
              id: entry.data.id,
              title: ticketTitle(entry),
              kind: entry.data.kind,
              blocked_by: entry.data.blocked_by || [],
              touches: entry.data.touches || [],
              sources: entry.data.sources || [],
            })),
            errors: plan.errors,
            applied: audit,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(slug);
    printTickets(root, slug);
  },

  defaults({ flags, positional }) {
    const root = rootDir(flags);
    const slug = positional[0] && positional[0] !== true ? positional[0] : flags.campaign;
    const campaign = slug ? readCampaign(root, resolveCampaign(root, slug)) : null;
    const config = loadConsole();
    const runner = runnerConfig(config, campaign?.data || {});
    const adapter = flags.adapter || runner.adapter;
    /* an explicit adapter brings its own default spend mode; only the runner
       adapter inherits the console/campaign setting */
    const spend = flags.adapter ? DEFAULT_SPEND[adapter] || "metered-ok" : runner.spend;
    const plan = campaign ? loadPlan(root, campaign.slug) : null;
    const target = campaign ? campaign.data.kinds || {} : config.kinds;
    const effective = campaign ? resolveKinds(config, campaign.data) : config.kinds;
    const allKinds = campaign
      ? [...new Set([...ticketKindsUsed(plan.ordered), ...Object.keys(campaign.data.kinds || {}), "review"])].sort()
      : Object.keys(config.kinds);
    /* fill only chains that are effectively empty; --force replaces even the
       ones inherited from the console */
    const pending = pendingDefaultKinds(effective, { force: Boolean(flags.force), kinds: allKinds });
    if (!pending.length) {
      console.log(
        campaign
          ? "every chain this campaign uses is already bound; pass --force to pin the newest releases here"
          : "every console chain is already bound; pass --force to replace them",
      );
      return;
    }
    const resolved = resolveDefaultChains({
      rows: rowsFor(adapter, root),
      adapter,
      spend,
      kinds: pending,
      avoid: flags.force ? null : boundFirstModels(effective, pending),
    });
    if (flags.json) {
      console.log(JSON.stringify(resolved, null, 2));
    } else {
      for (const [kind, chain] of Object.entries(resolved.chains)) {
        console.log(`${kind.padEnd(9)} ${chain.models.map((entry) => `${entry.model}:${entry.thinking}`).join(" -> ")}`);
      }
      for (const note of resolved.notes.filter((n) => !n.fallback)) {
        console.log(`  ${note.kind}: ${note.label} ${note.version} -> ${note.model}${note.included ? " (included)" : ""}`);
      }
      for (const warning of resolved.warnings) console.error(`! ${warning}`);
    }
    if (!flags.apply) {
      if (!flags.json) console.log("\nDry run. Pass --apply to write these chains; --force rebinds non-empty ones.");
      return;
    }
    if (!campaign && flags.adapter && adapter !== runner.adapter) {
      throw new UserError(`the console runner uses "${runner.adapter}", not "${adapter}"`, [
        `Preview is fine, but apply needs the console on that adapter: orchestrate adapter ${adapter}`,
      ]);
    }
    if (!Object.keys(resolved.chains).length) {
      throw new UserError(`no default chain resolved from the ${adapter} catalog`, [
        `Run \`orchestrate catalog --adapter ${adapter} --refresh\` and try again.`,
      ]);
    }
    const applied = [];
    for (const [kind, chain] of Object.entries(resolved.chains)) {
      target[kind] = { ...(target[kind] || {}), models: chain.models };
      applied.push(kind);
    }
    if (campaign) {
      const state = loadState(root, campaign.slug);
      const live = Object.values(state.runs).some((run) => run.status === "live");
      if ((state.stage === "running" || campaign.data.stage === "running" || live) && !flags.force) {
        throw new UserError(`Campaign "${campaign.slug}" is running; defaults may change only while nothing is running`, [
          `Pause it first: orchestrate pause ${campaign.slug}`,
          "or pass --force if you mean to change it under a live run.",
        ]);
      }
      fs.writeFileSync(campaign.file, joinFrontmatter({ ...campaign.data, kinds: target }, campaign.body));
    } else {
      saveConsole(config);
    }
    console.log(
      applied.length
        ? `applied defaults to ${campaign ? campaign.slug : "the console"}: ${applied.join(", ")}`
        : campaign
          ? "this campaign already inherits the same chains; pass --force to pin them here"
          : "every console chain was already bound; pass --force to replace them",
    );
  },

  bind({ flags, positional }) {
    const root = rootDir(flags);
    const [campaignArg, kindId, modelArg] = positional;
    if (!kindId || !modelArg) {
      throw new UserError("Usage: orchestrate bind <campaign> <kind> <model>[:thinking] [--fallback <model>[:thinking]]");
    }
    const slug = resolveCampaign(root, campaignArg);
    const campaign = readCampaign(root, slug);
    const runner = runnerConfig(loadConsole(), campaign.data);
    const adapterId = flags.adapter || runner.adapter;
    try {
      if (adapterId !== "pi") refreshCatalog(adapterId, { cwd: root });
    } catch (err) {
      throw new UserError(`adapter "${adapterId}" could not discover models`, [
        err.message,
        err.hint || "Check that the harness is installed and signed in.",
      ]);
    }
    const rows = rowsFor(adapterId, root);
    const parse = (value) => {
      const [model, thinking] = String(value).split(":");
      const resolved = resolveModel(model, rows);
      if (!resolved) {
        throw new UserError(`"${model}" is not in the catalog for adapter "${adapterId}"`, [
          `Run \`orchestrate catalog --adapter ${adapterId}\` and pick a model id.`,
        ]);
      }
      if (resolved.adapter && resolved.adapter !== adapterId) {
        throw new UserError(`"${model}" belongs to adapter "${resolved.adapter}", not "${adapterId}"`);
      }
      if (runner.spend === "subscription-only" && resolved.included === false) {
        throw new UserError(`"${model}" is not included in the ${adapterId} subscription`, [
          "Set runner.spend: metered-ok on the campaign to allow metered models.",
        ]);
      }
      if (["code", "design", "visual", "review"].includes(kindId) && resolved.price && resolved.price.input === 0 && resolved.price.output === 0) {
        throw new UserError(`"${model}" is free/promo and not allowed for kind "${kindId}"`, [
          "Bind a paid or self-hosted model for production kinds.",
        ]);
      }
      return { adapter: adapterId, model: `${resolved.provider}/${resolved.model}`, thinking: thinking || "medium" };
    };
    const chain = [parse(modelArg)];
    const fallbacks = flags.fallback ? (Array.isArray(flags.fallback) ? flags.fallback : [flags.fallback]) : [];
    for (const value of fallbacks) chain.push(parse(value));

    const state = loadState(root, slug);
    const live = Object.values(state.runs).some((run) => run.status === "live");
    if ((state.stage === "running" || campaign.data.stage === "running" || live) && !flags.force) {
      throw new UserError(
        `Campaign "${slug}" is running; a binding may change only while nothing is running`,
        ["Pause it first: orchestrate pause " + slug, "or pass --force if you mean to change it under a live run."],
      );
    }
    const kinds = campaign.data.kinds || {};
    kinds[kindId] = { ...(kinds[kindId] || {}), models: chain };
    fs.writeFileSync(campaign.file, joinFrontmatter({ ...campaign.data, kinds }, campaign.body));
    console.log(`${slug} ${kindId}: ${chain.map((c) => `${c.adapter}/${c.model}:${c.thinking}`).join(" -> ")}`);
  },

  approve({ flags, positional }) {
    const root = rootDir(flags);
    const slug = resolveCampaign(root, flags.campaign || positional[0]);
    const draft = readDraft(root, slug);
    if (draft.exists) {
      throw new UserError(`Campaign "${slug}" has an unapplied draft plan`, [
        `Review it: orchestrate plan diff ${slug}`,
        `Apply it: orchestrate plan import ${slug}`,
        `Or abandon it: orchestrate plan discard ${slug}`,
      ]);
    }
    approveCampaign(root, slug, loadConsole());
    console.log(`approved ${slug}`);
    tickNow(root);
  },

  status({ flags, positional }) {
    const root = rootDir(flags);
    const slugs = positional[0] ? [resolveCampaign(root, positional[0])] : listCampaigns(root);
    if (flags.json) {
      console.log(JSON.stringify(projectView(root), null, 2));
      return;
    }
    if (!slugs.length) {
      console.log("no campaigns");
      return;
    }
    for (const slug of slugs) {
      const view = campaignView(root, slug);
      const counts = {};
      for (const ticket of view.tickets) counts[ticket.stage] = (counts[ticket.stage] || 0) + 1;
      console.log(`${slug} [${view.stage}]${view.reason ? ` ${view.reason}` : ""}`);
      const countText = Object.entries(counts)
        .map(([stage, n]) => `${n} ${stage}`)
        .join(", ");
      console.log(`  ${view.tickets.length} tickets${countText ? `: ${countText}` : ""}`);
      if (view.draft?.exists) {
        console.log(
          view.draft.error
            ? `  draft invalid: ${view.draft.error}`
            : `  draft ${view.draft.tickets} ticket${view.draft.tickets === 1 ? "" : "s"} · not applied · ${view.draft.hash}`,
        );
      }
      console.log(
        `  spend ${view.spend.tokens} tokens, ${money(view.spend.dollars)}; ` +
          `${view.inbox.filter((i) => i.status === "open").length} open inbox items`,
      );
      for (const error of view.planErrors) {
        if (view.draft?.exists && /no tickets/i.test(error)) continue;
        console.log(`  ! ${error}`);
      }
      printTickets(root, slug);
    }
  },

  inbox({ flags }) {
    const root = rootDir(flags);
    const items = listCampaigns(root).flatMap((slug) =>
      listItems(root, slug)
        .filter((item) => item.status === "open" && item.kind !== "review")
        .map((item) => ({ ...item, campaign: slug })),
    );
    if (flags.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    if (!items.length) {
      console.log("inbox empty");
      return;
    }
    for (const item of items) {
      console.log(`${item.id}  [${item.kind}] ${item.campaign}${item.ticket ? ` / ${item.ticket}` : ""}`);
      console.log(`  ${item.title}`);
      if (item.question?.text) console.log(`  ? ${item.question.text}`);
      if (item.brief) console.log(`  ${item.brief.split("\n")[0]}`);
    }
  },

  acceptance({ flags }) {
    const root = rootDir(flags);
    const items = listCampaigns(root).flatMap((slug) =>
      listItems(root, slug)
        .filter((item) => item.status === "open" && item.kind === "review")
        .map((item) => ({ ...item, campaign: slug })),
    );
    if (flags.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    if (!items.length) {
      console.log("nothing is waiting for acceptance");
      return;
    }
    for (const item of items) {
      const view = campaignView(root, item.campaign);
      const stats = view.delivery?.stats;
      console.log(`${item.id}  ${item.campaign}  ${item.title}`);
      if (stats) console.log(`  ${stats.added} added, ${stats.removed} removed · limit ${view.maxAutoshipLines}`);
      if (item.brief) console.log(`  ${item.brief.split("\n")[0]}`);
    }
  },

  answer({ flags, positional }) {
    const root = rootDir(flags);
    const [id, ...text] = positional;
    const found = findItem(root, id);
    if (!found) throw new UserError(`No inbox item "${id}"`);
    enqueue(root, { type: "answer", campaign: found.slug, item: found.item.id, text: text.join(" ") });
    tickNow(root);
  },

  review({ flags, positional }) {
    const root = rootDir(flags);
    const [id, decision, ...text] = positional;
    if (!["approve", "reject"].includes(decision)) throw new UserError("Usage: orchestrate review <item> approve|reject [text]");
    const found = findItem(root, id);
    if (!found) throw new UserError(`No inbox item "${id}"`);
    enqueue(root, {
      type: decision === "approve" ? "review.approve" : "review.reject",
      campaign: found.slug,
      item: found.item.id,
      text: text.join(" "),
    });
    tickNow(root);
    if (decision === "approve") {
      const after = findItem(root, id);
      const state = loadState(root, found.slug);
      if (after?.status === "open") {
        console.error(`not merged: ${state.delivery?.detail || "the delivery did not merge"}`);
        process.exitCode = 1;
      } else if (state.delivery?.mode === "merged") {
        console.log(`merged: ${state.delivery.detail}`);
      }
    }
  },

  deliver({ flags, positional }) {
    const root = rootDir(flags);
    const slug = resolveCampaign(root, flags.campaign || positional[0]);
    enqueue(root, { type: "deliver", campaign: slug });
    const result = tickNow(root);
    const state = loadState(root, slug);
    if (state.delivery?.mode === "merged") console.log(`merged: ${state.delivery.detail}`);
    else console.log(`not merged: ${state.delivery?.detail || "no delivery to take"}`);
    return (result.results || []).find((r) => r.slug === slug);
  },

  retry({ flags, positional }) {
    const root = rootDir(flags);
    const slug = resolveCampaign(root, flags.campaign);
    enqueue(root, { type: "retry", campaign: slug, ticket: positional[0] });
    tickNow(root);
  },

  stop({ flags, positional }) {
    const root = rootDir(flags);
    const slug = resolveCampaign(root, flags.campaign);
    enqueue(root, { type: "stop", campaign: slug, ticket: positional[0] });
    tickNow(root);
  },

  pause({ flags, positional }) {
    const root = rootDir(flags);
    const slug = resolveCampaign(root, flags.campaign || positional[0]);
    enqueue(root, { type: "pause", campaign: slug });
    tickNow(root);
  },

  resume({ flags, positional }) {
    const root = rootDir(flags);
    const slug = resolveCampaign(root, flags.campaign || positional[0]);
    enqueue(root, { type: "resume", campaign: slug });
    tickNow(root);
  },

  dispatch({ flags, positional }) {
    const action = positional[0] || (flags.pause ? "pause" : flags.resume ? "resume" : "status");
    if (action === "status") {
      const dispatch = loadDispatch();
      if (flags.json) {
        console.log(JSON.stringify(dispatch, null, 2));
        return;
      }
      console.log(`dispatch  ${dispatch.mode}${dispatch.reason ? ` · ${dispatch.reason}` : ""}`);
      if (dispatch.at) console.log(`changed   ${dispatch.at}${dispatch.by ? ` by ${dispatch.by}` : ""}`);
      return;
    }
    if (!["pause", "resume", "auto"].includes(action))
      throw new UserError('Usage: orchestrate dispatch [status|pause|resume] [--reason "why"]');
    const reason = flags.reason ? String(flags.reason) : action === "pause" ? "" : null;
    try {
      const dispatch = setDispatch(action === "pause" ? "paused" : "auto", { reason, by: "cli" });
      console.log(`dispatch  ${dispatch.mode}${dispatch.reason ? ` · ${dispatch.reason}` : ""}`);
    } catch (err) {
      throw new UserError(err.message, ['Pass --reason "quota exhausted" or another short cause.']);
    }
  },

  quota({ flags, positional }) {
    const action = positional[0] || "list";
    const config = loadConsole();
    const quotas = validateQuotas(config.quotas || []).quotas;
    if (action === "list") {
      if (flags.json) {
        console.log(JSON.stringify(quotas, null, 2));
        return;
      }
      if (!quotas.length) {
        console.log("no quotas configured");
        return;
      }
      for (const quota of quotas) {
        console.log(
          `${(quota.provider || quota.adapter || "?").padEnd(20)} ${String(quota.window).padEnd(8)} ` +
            `${quota.used}/${quota.limit}  ${quota.source.padEnd(7)} ${quota.resetAt || "no reset"}`,
        );
      }
      return;
    }
    if (action === "remove") {
      const provider = positional[1] || flags.provider;
      if (!provider) throw new UserError("Usage: orchestrate quota remove <provider> [--window 5h]");
      if (flags.window) {
        config.quotas = quotas.filter(
          (quota) => !(quota.provider === provider && quota.window === String(flags.window)),
        );
      } else {
        config.quotas = quotas.filter((quota) => quota.provider !== provider);
      }
      saveConsole(config);
      console.log(`removed ${provider}`);
      return;
    }
    if (action !== "set") throw new UserError("Usage: orchestrate quota list|set|remove ...");
    const provider = positional[1] || flags.provider;
    if (!provider) throw new UserError("Usage: orchestrate quota set <provider> --window 5h --used 72 --limit 100");
    const next = quotas.filter(
      (quota) =>
        !(
          quota.provider === provider &&
          quota.window === String(flags.window || "weekly") &&
          (quota.adapter || null) === (flags.adapter || null)
        ),
    );
    const candidate = {
      provider,
      adapter: flags.adapter || null,
      window: flags.window || "weekly",
      used: flags.used == null ? 0 : Number(flags.used),
      limit: flags.limit == null ? 100 : Number(flags.limit),
      resetAt: flags.reset || flags["reset-at"] || null,
      source: flags.source || "manual",
      updatedAt: nowIso(),
    };
    next.push(candidate);
    const checked = validateQuotas(next);
    if (checked.errors.length) throw new UserError(`Invalid quota: ${checked.errors.join("; ")}`);
    config.quotas = checked.quotas;
    saveConsole(config);
    console.log(`set ${provider} ${candidate.window}: ${candidate.used}/${candidate.limit}${candidate.resetAt ? ` resets ${candidate.resetAt}` : ""}`);
  },

  tick({ flags }) {
    const root = rootDir(flags);
    const result = tick({ root });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (!result.results.length) console.log("no campaigns");
    for (const row of result.results) {
      if (row.error) console.log(`${row.slug}: ${row.error}`);
      else console.log(`${row.slug} [${row.stage}] ` + row.tickets.map((t) => `${t.id}:${t.stage}`).join("  "));
    }
  },

  async up({ flags }) {
    const here = nearestProject(process.cwd());
    const root = flags.root ? path.resolve(flags.root) : here || registryRoots()[0];
    if (!root) throw new UserError("This is not an orchestration project", ["Run `orchestrate init` here first."]);
    const info = readJson(globalPanelFile(), null);
    if (info?.url && pidAlive(info.pid) && (await reachable(info.url))) {
      console.log(info.url);
      if (!flags["no-open"]) openBrowser(info.url);
      return;
    }
    ensureConsole();
    if (here || flags.root) registryAdd(root);
    const log = path.join(consoleStateDir(), "panel.log");
    ensureDir(consoleStateDir());
    const out = fs.openSync(log, "a");
    const child = spawnDetached(process.execPath, [process.argv[1], "run", "--root", root], {
      cwd: root,
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    try {
      fs.closeSync(out);
    } catch {
      // already closed
    }
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const fresh = readJson(globalPanelFile(), null);
      if (fresh?.url && fresh.pid === child.pid) {
        console.log(fresh.url);
        console.log(`log  ${log}`);
        console.log(`stop orchestrate down`);
        if (!flags["no-open"]) openBrowser(fresh.url);
        return;
      }
    }
    throw new UserError("The panel did not come up", [`Read the log: ${log}`]);
  },

  down() {
    const info = readJson(globalPanelFile(), null);
    if (!info?.pid || !pidAlive(info.pid)) {
      console.log("no panel is running");
      try {
        fs.unlinkSync(globalPanelFile());
      } catch {
        /* nothing to clean */
      }
      return;
    }
    try {
      process.kill(info.pid);
    } catch (err) {
      throw new UserError(`could not stop the panel: ${err.message}`);
    }
    console.log(`stopped ${info.pid}`);
  },

  link({ flags }) {
    const dir = flags.dir || binHome();
    ensureDir(dir);
    const target = path.join(dir, "orchestrate");
    const script = process.argv[1];
    const body = `#!/bin/sh\n# generated by orchestrate link; re-run it if the skill moves\nexec "${process.execPath}" "${script}" "$@"\n`;
    fs.writeFileSync(target, body, { mode: 0o755 });
    console.log(target);
    console.log("");
    console.log("Now:  orchestrate up");
    const onPath = String(process.env.PATH || "").split(":").includes(dir);
    if (!onPath) console.log(`      ${dir} is not on PATH; add it to your shell profile.`);
  },

  desktop({ flags, positional }) {
    const action = positional[0] || "install";
    const dir = path.join(dataHome(), "applications");
    const file = path.join(dir, "orchestration.desktop");
    if (action === "remove" || action === "uninstall") {
      try {
        fs.unlinkSync(file);
        console.log(`removed ${file}`);
      } catch {
        console.log("no desktop entry to remove");
      }
      return;
    }
    ensureDir(dir);
    const launcher = path.join(binHome(), "orchestrate");
    const exec = fileExists(launcher) ? launcher : `${process.execPath} ${process.argv[1]}`;
    fs.writeFileSync(
      file,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Orchestration",
        "Comment=Campaign board and inbox",
        `Exec=${exec} up`,
        "Icon=utilities-system-monitor",
        "Terminal=false",
        "Categories=Development;",
        "StartupNotify=false",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    console.log(file);
  },

  async run({ flags }) {
    const root = rootDir(flags);
    ensureConsole();
    registryAdd(root);
    const config = loadConsole();
    const rootsNow = () => [...new Set([root, ...registryRoots()].filter((p) => exists(p)))];
    const interval = Number(flags.interval || 2000);
    let busy = false;
    let stopped = false;

    const tickAll = () => {
      if (busy || stopped) return;
      busy = true;
      try {
        for (const project of rootsNow()) tick({ root: project });
      } catch (err) {
        console.error(`tick failed: ${err.message}`);
      } finally {
        busy = false;
      }
    };

    const panel = await startServer({
      roots: rootsNow(),
      getRoots: rootsNow,
      port: Number(flags.port || config.panel.port),
      bind: config.panel.bind,
      token: panelToken(),
      onCommand: tickAll,
      log: (line) => console.log(line),
    });
    console.log(`watching  ${rootsNow().join(", ")}`);
    tickAll();
    const timer = setInterval(tickAll, interval);
    const shutdown = () => {
      stopped = true;
      clearInterval(timer);
      panel.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => {});
  },

  panel({ flags }) {
    const root = rootDir(flags);
    const global = readJson(globalPanelFile(), null);
    const info = global?.url && pidAlive(global.pid) ? global : readJson(path.join(root, ".orchestration", "panel.json"), null);
    if (!info) throw new UserError("No panel has run for this project", ["Start one with `orchestrate run`."]);
    console.log(info.url);
  },

  help() {
    console.log(`orchestrate <verb>

  init                                  scaffold this project, register it, write console defaults
  start "<goal>"                        create a draft campaign
  plan [campaign] [--json]              list tickets and validation errors
  plan draft <campaign> --file f        save a draft, show both deltas; tickets untouched
  plan diff <campaign>                  reprint the draft deltas
  plan show <campaign> [--ticket k]     full draft ticket text; --applied
  plan import <campaign> [--file f]      apply the draft or a file atomically; --prune, --accept-open
  plan discard <campaign>               abandon the draft
  plan audit <campaign> [--write]       show or persist the applied-plan audit
  context [--ticket 03]                 the substrate a worker reads: decisions, siblings, diff, history
  context append <campaign> --from f   append free-form human context to context.md
  decisions [campaign] [--all]          list decisions, with ids
  promote <decision-id> [campaign]      share one decision with every campaign
  ticket add|edit|remove ...            change the plan: add, edit a ticket, remove one
  cancel [campaign]                     stop every live run and pause
  archive [campaign]                    close a delivered campaign
  catalog [search]                       the live model catalog; --adapter <id> [--refresh]
  adapters                               adapters, versions and catalog status
  doctor [--refresh]                      check harness versions and catalog freshness
  adapter <id> [--spend mode]            set the console adapter and spend mode
  defaults [campaign] [--apply]          resolve the newest default family per kind; --force rebinds
  bind <campaign> <kind> <model>[:t]    set a kind's chain; --fallback for the next entry
  approve <campaign>                    approve plan and bindings, then dispatch
  up                                    start the panel if needed, open it, print the URL
  down                                  stop the panel
  link                                  put an orchestrate command in ~/.local/bin
  desktop [remove]                      add a launcher to the desktop menu
  run                                   supervisor + panel for every registered project
  tick                                  one pass, no panel
  status [campaign] [--json]            stages, spend, plan errors
  inbox [--json]                        open questions and failures across campaigns
  acceptance [--json]                   deliveries waiting for a person
  answer <item> "<text>"                deliver a decision and resume the run
  review <item> approve|reject [text]   accept a delivery or send it back
  deliver <campaign>                    take a manual delivery now
  retry <ticket> | stop <ticket>        control one ticket
  pause | resume <campaign>             stop or resume dispatch
  dispatch [status|pause|resume]        the console-wide switch; --reason when pausing
  quota list|set|remove ...             provider windows: --window 5h --used 72 --limit 100
  panel                                 print the panel URL
`);
  },
};

async function reachable(url) {
  try {
    const target = new URL(url);
    target.pathname = "/api/state";
    const res = await fetch(target, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = spawnDetached(command, [url], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    /* headless or no desktop: the URL is printed anyway */
  }
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "campaign";
}

async function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0] || "help";
  const { positional, flags } = parseArgs(argv.slice(1));
  const handler = commands[verb];
  if (!handler) {
    console.error(`unknown verb "${verb}"`);
    commands.help();
    process.exit(2);
  }
  try {
    await handler({ flags, positional });
  } catch (err) {
    if (err instanceof UserError) {
      console.error(err.message);
      for (const hint of err.hints || []) console.error(`  ${hint}`);
      process.exit(1);
    }
    console.error(err.stack || err.message);
    process.exit(1);
  }
}

main();
