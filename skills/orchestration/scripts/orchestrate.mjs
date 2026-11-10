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
  writeJson,
  consoleFile,
  consoleStateDir,
  exists as fileExists,
  globalPanelFile,
  panelToken,
  pidAlive,
} from "./lib/util.mjs";
import { catalog, ensureConsole, listCampaigns, loadConsole, readCampaign, resolveModel } from "./lib/config.mjs";
import { asArray, loadPlan, ticketTitle } from "./lib/plan.mjs";
import { decisionsFor, promoteDecision, readDecisions, summaryLine } from "./lib/memory.mjs";
import { readEvents } from "./lib/ledger.mjs";
import { diffStats, integrationBranch } from "./lib/landing.mjs";
import { approveCampaign, tick } from "./lib/engine.mjs";
import { enqueue } from "./lib/commands.mjs";
import { listItems } from "./lib/inbox.mjs";
import { campaignView, projectView } from "./lib/view.mjs";
import { startServer } from "./lib/server.mjs";
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
  return path.resolve(flags.root || process.cwd());
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
  for (const error of plan.errors) console.log(`  ! ${error}`);
  return plan;
}

const commands = {
  init({ flags }) {
    const root = rootDir(flags);
    ensureConsole();
    ensureDir(path.join(root, ".orchestration"));
    ensureDir(path.join(root, "orchestration"));
    ensureGitignore(root);
    registryAdd(root);
    const { created } = ensureConsole();
    console.log(`project   ${root}`);
    console.log(`state     ${path.join(root, ".orchestration")}`);
    console.log(`console   ${consoleFile()}${created ? " (created)" : ""}`);
    const rows = catalog();
    console.log(`catalog   ${rows.length} models, ${new Set(rows.map((r) => r.provider)).size} providers`);
    console.log("");
    console.log('Next: orchestrate start "<goal>"');
  },

  catalog({ flags, positional }) {
    const rows = catalog();
    const search = (positional[0] || "").toLowerCase();
    const list = rows.filter((r) => !search || `${r.provider}/${r.model}`.toLowerCase().includes(search));
    if (flags.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`${pad("model", 44)} ${pad("context", 10)} ${pad("out", 8)} think  images`);
    for (const row of list) {
      console.log(
        `${pad(`${row.provider}/${row.model}`, 44)} ${pad(row.context, 10)} ${pad(row.maxOut, 8)} ${row.thinking ? "yes" : "no "}    ${row.images ? "yes" : "no"}`,
      );
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
    console.log(`  node ${self} bind ${created.slug} code <provider/model>:high --fallback <provider/model>:medium`);
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

  plan({ flags }) {
    const root = rootDir(flags);
    const slug = resolveCampaign(root, flags.campaign);
    console.log(slug);
    printTickets(root, slug);
  },

  bind({ flags, positional }) {
    const root = rootDir(flags);
    const [campaignArg, kindId, modelArg] = positional;
    if (!kindId || !modelArg) {
      throw new UserError("Usage: orchestrate bind <campaign> <kind> <model>[:thinking] [--fallback <model>[:thinking]]");
    }
    const rows = catalog();
    const parse = (value) => {
      const [model, thinking] = String(value).split(":");
      const resolved = resolveModel(model, rows);
      if (!resolved) throw new UserError(`"${model}" is not in the catalog`, ["Run `orchestrate catalog` and pick a model id."]);
      return { model: `${resolved.provider}/${resolved.model}`, thinking: thinking || "medium" };
    };
    const chain = [parse(modelArg)];
    const fallbacks = flags.fallback ? (Array.isArray(flags.fallback) ? flags.fallback : [flags.fallback]) : [];
    for (const value of fallbacks) chain.push(parse(value));

    const slug = resolveCampaign(root, campaignArg);
    const campaign = readCampaign(root, slug);
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
    console.log(`${slug} ${kindId}: ${chain.map((c) => `${c.model}:${c.thinking}`).join(" -> ")}`);
  },

  approve({ flags, positional }) {
    const root = rootDir(flags);
    const slug = resolveCampaign(root, flags.campaign || positional[0]);
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
      console.log(
        `  ${view.tickets.length} tickets: ` +
          Object.entries(counts)
            .map(([stage, n]) => `${n} ${stage}`)
            .join(", "),
      );
      console.log(
        `  spend ${view.spend.tokens} tokens, ${money(view.spend.dollars)}; ` +
          `${view.inbox.filter((i) => i.status === "open").length} open inbox items`,
      );
      for (const error of view.planErrors) console.log(`  ! ${error}`);
      printTickets(root, slug);
    }
  },

  inbox({ flags }) {
    const root = rootDir(flags);
    const items = listCampaigns(root).flatMap((slug) =>
      listItems(root, slug)
        .filter((item) => item.status === "open")
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
  plan [campaign]                       list tickets and validation errors
  context [--ticket 03]                 the substrate a worker reads: decisions, siblings, diff, history
  decisions [campaign] [--all]          list decisions, with ids
  promote <decision-id> [campaign]      share one decision with every campaign
  ticket add|edit|remove ...            change the plan: add, edit a ticket, remove one
  cancel [campaign]                     stop every live run and pause
  archive [campaign]                    close a delivered campaign
  catalog [search]                      the live model catalog
  bind <campaign> <kind> <model>[:t]    set a kind's chain; --fallback for the next entry
  approve <campaign>                    approve plan and bindings, then dispatch
  up                                    start the panel if needed, open it, print the URL
  down                                  stop the panel
  link                                  put an orchestrate command in ~/.local/bin
  desktop [remove]                      add a launcher to the desktop menu
  run                                   supervisor + panel for every registered project
  tick                                  one pass, no panel
  status [campaign] [--json]            stages, spend, plan errors
  inbox [--json]                        open items across campaigns
  answer <item> "<text>"                deliver a decision and resume the run
  review <item> approve|reject [text]   accept a delivery or send it back
  deliver <campaign>                    take a manual delivery now
  retry <ticket> | stop <ticket>        control one ticket
  pause | resume <campaign>             stop or resume dispatch
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
