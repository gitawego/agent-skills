// The read model: one snapshot the panel and the CLI both render from.
import path from "node:path";
import {
  consoleFile,
  exists,
  projectStateDir,
  readJson,
  readJsonl,
  readText,
} from "./util.mjs";
import { listCampaigns, loadConsole, readCampaign, resolveKinds } from "./config.mjs";
import { loadPlan, ticketTitle, asArray } from "./plan.mjs";
import { loadState } from "./state.mjs";
import { readEvents } from "./ledger.mjs";
import { readDecisions } from "./memory.mjs";
import { listItems } from "./inbox.mjs";
import { campaignDecisionsFile } from "./util.mjs";

export function projectName(root) {
  return path.basename(root);
}

export function campaignView(root, slug) {
  const campaign = readCampaign(root, slug);
  const plan = loadPlan(root, slug);
  const state = loadState(root, slug);
  const tickets = plan.ordered.map((ticket) => {
    const entry = state.tickets[ticket.data.id] || {};
    const run = entry.run ? state.runs[entry.run] : null;
    return {
      id: ticket.data.id,
      title: ticketTitle(ticket),
      kind: ticket.data.kind,
      stage: entry.stage || "queued",
      blockedBy: asArray(ticket.data.blocked_by).map((b) => String(b).padStart(2, "0")),
      touches: asArray(ticket.data.touches),
      accepted: ticket.criteria,
      body: ticket.what,
      notes: ticket.notes,
      attempts: entry.attempts || 0,
      gateCycles: entry.gateCycles || 0,
      waitingOn: entry.waitingOn || null,
      summary: entry.summary || null,
      findings: entry.findings || null,
      answer: entry.answer || null,
      model: entry.model || null,
      run: run
        ? {
            id: run.id,
            role: run.role,
            model: run.model,
            status: run.status,
            startedAt: run.startedAt,
            pid: run.pid,
            workdir: run.workdir,
          }
        : null,
    };
  });
  const runs = Object.entries(state.runs)
    .map(([id, run]) => ({
      id,
      ticket: run.ticket,
      role: run.role,
      kind: run.kind,
      model: run.model,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      killed: run.killed || null,
      reportStatus: run.reportStatus || null,
      tokens: run.usage?.tokens || 0,
      dollars: run.usage?.dollars || 0,
      unmetered: Boolean(run.usage?.unmetered),
    }))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  return {
    slug,
    stage: state.stage,
    reason: state.reason,
    autonomy: campaign.data.autonomy || "supervised",
    planGate: campaign.data.plan_gate || "human",
    landing: campaign.data.landing || "branch",
    base: campaign.data.base || "main",
    budget: campaign.data.budget || null,
    maxAutoshipLines: campaign.data.max_autoship_lines ?? 200,
    checks: (campaign.data.checks || []).map((c) => ({ name: c.name, cmd: c.cmd })),
    allowPaths: campaign.data.allow_paths || [],
    goal: (campaign.sections.goal || "").trim(),
    brief: (campaign.sections.brief || "").trim(),
    criteria: (campaign.sections["acceptance criteria"] || "").trim(),
    constraints: (campaign.sections.constraints || "").trim(),
    reading: (campaign.sections["what to read first"] || "").trim(),
    kinds: Object.fromEntries(
      Object.entries(campaign.data.kinds || {}).map(([id, kind]) => [
        id,
        { models: (kind.models || []).map((m) => ({ model: m.model, thinking: m.thinking || null })) },
      ]),
    ),
    effectiveKinds: Object.fromEntries(
      Object.entries(resolveKinds(loadConsole(), campaign.data)).map(([id, kind]) => [
        id,
        {
          label: kind.label,
          description: kind.description,
          models: kind.models.map((m) => ({ model: m.model, thinking: m.thinking || null })),
          max_concurrent: kind.max_concurrent,
          tools: kind.tools,
          timeout_min: kind.timeout_min,
          overridden: Boolean((campaign.data.kinds || {})[id]),
        },
      ]),
    ),
    planErrors: state.planErrors || [],
    spend: state.spend,
    delivery: state.delivery || null,
    tickets,
    runs,
    inbox: listItems(root, slug),
    events: readEvents(root)
      .filter((event) => event.campaign === slug)
      .slice(-40)
      .map((event) => ({
        ts: event.ts,
        ticket: event.ticket || null,
        type: event.type,
        data: event.data || {},
      })),
    decisions: readDecisions(root, slug).slice(-50),
  };
}

export function projectView(root) {
  const slugs = listCampaigns(root);
  return {
    root,
    name: projectName(root),
    campaigns: slugs.map((slug) => {
      try {
        return campaignView(root, slug);
      } catch (err) {
        return { slug, error: err.message, stage: "draft", tickets: [], runs: [], inbox: [] };
      }
    }),
  };
}

export function readPanelInfo(root) {
  return readJson(path.join(projectStateDir(root), "panel.json"), null);
}

export function readEventFile(root) {
  return readText(path.join(projectStateDir(root), "events.jsonl"), "");
}

export function consoleView() {
  const config = loadConsole();
  return { file: consoleFile(), config };
}

export function projectExists(root) {
  return exists(path.join(projectStateDir(root)));
}
