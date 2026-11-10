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
import { listCampaigns, loadConsole, readCampaign, resolveKinds, runnerConfig } from "./config.mjs";
import { loadPlan, ticketTitle, asArray } from "./plan.mjs";
import { loadState } from "./state.mjs";
import { readEvents } from "./ledger.mjs";
import { readDecisions } from "./memory.mjs";
import { listItems } from "./inbox.mjs";
import { campaignDecisionsFile } from "./util.mjs";
import { resolveQuotas } from "./quotas.mjs";
import { costOf, summarizeCost, telemetryOf } from "./telemetry.mjs";
import { usageFromLog } from "./runs.mjs";

export function projectName(root) {
  return path.basename(root);
}

export function campaignView(root, slug) {
  const campaign = readCampaign(root, slug);
  const plan = loadPlan(root, slug);
  const state = loadState(root, slug);
  const consoleConfig = loadConsole();
  const effectiveKinds = resolveKinds(consoleConfig, campaign.data);
  const runner = runnerConfig(consoleConfig, campaign.data);

  const runs = Object.entries(state.runs)
    .map(([id, run]) => {
      const liveUsage = run.status === "live" ? usageFromLog(root, slug, id) : null;
      const usage = liveUsage && (liveUsage.tokens || liveUsage.dollars) ? liveUsage : run.usage || liveUsage;
      const source = { ...run, usage };
      const telemetry = telemetryOf(source);
      return {
        id,
        ticket: run.ticket,
        role: run.role,
        kind: run.kind,
        model: run.model,
        adapter: run.adapter || null,
        adapterVersion: run.adapterVersion || null,
        host: run.host || null,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: telemetry.seconds == null ? null : Math.round(telemetry.seconds * 1000),
        killed: run.killed || null,
        reportStatus: run.reportStatus || null,
        tokens: usage?.tokens || telemetry.tokens,
        dollars: usage?.dollars || 0,
        unmetered: Boolean(usage?.unmetered),
        inputTokens: telemetry.inputTokens,
        outputTokens: telemetry.outputTokens,
        cachedReadTokens: telemetry.cachedReadTokens,
        promptTokens: telemetry.promptTokens,
        cacheHit: telemetry.cacheHit,
        tokensPerSecond: telemetry.tokensPerSecond,
        contextTokens: run.contextTokens || null,
        billing: run.billing || null,
        included: run.included ?? null,
        price: run.price || null,
        usageSource: usage?.source || null,
        children: run.children || [],
        childTokens: run.childUsage?.tokens || 0,
        childDollars: run.childUsage?.dollars || 0,
        totalTokens: (usage?.tokens || telemetry.tokens) + (run.childUsage?.tokens || 0),
        cost: costOf(source),
      };
    })
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const runsByTicket = new Map();
  for (const run of runs) {
    if (!run.ticket) continue;
    if (!runsByTicket.has(run.ticket)) runsByTicket.set(run.ticket, []);
    runsByTicket.get(run.ticket).push(run);
  }

  const tickets = plan.ordered.map((ticket) => {
    const entry = state.tickets[ticket.data.id] || {};
    const run = entry.run ? state.runs[entry.run] : null;
    const ticketRuns = runsByTicket.get(ticket.data.id) || [];
    const workRun = [...ticketRuns].reverse().find((candidate) => candidate.role === "work") || ticketRuns[ticketRuns.length - 1];
    const chain = effectiveKinds[ticket.data.kind]?.models || [];
    const adapter = workRun?.adapter || chain[0]?.adapter || runner.adapter;
    const childRuns = ticketRuns
      .filter((candidate) => candidate.childTokens || candidate.childDollars)
      .map((candidate) => ({
        usage: {
          tokens: candidate.childTokens,
          dollars: candidate.childDollars,
          unmetered: candidate.unmetered,
          costFromProvider: candidate.cost?.label === "actual" ? true : undefined,
        },
        included: candidate.included,
        billing: candidate.billing,
        price: null,
      }));
    return {
      id: ticket.data.id,
      title: ticketTitle(ticket),
      kind: ticket.data.kind,
      stage: entry.stage || "queued",
      adapter,
      blockedBy: asArray(ticket.data.blocked_by).map((b) => String(b).padStart(2, "0")),
      touches: asArray(ticket.data.touches),
      attachments: asArray(ticket.data.attachments),
      accepted: ticket.criteria,
      body: ticket.what,
      notes: ticket.notes,
      attempts: entry.attempts || 0,
      gateCycles: entry.gateCycles || 0,
      waitingOn: entry.waitingOn || null,
      queue: entry.queue || null,
      updated: entry.updated || null,
      summary: entry.summary || null,
      findings: entry.findings || null,
      answer: entry.answer || null,
      model: entry.model || chain[0]?.model || null,
      cost: summarizeCost([...ticketRuns, ...childRuns]),
      run: run
        ? {
            id: run.id,
            role: run.role,
            model: run.model,
            adapter: run.adapter || null,
            status: run.status,
            startedAt: run.startedAt,
            pid: run.pid,
            workdir: run.workdir,
          }
        : null,
    };
  });
  return {
    slug,
    stage: state.stage,
    reason: state.reason,
    autonomy: campaign.data.autonomy || "supervised",
    planGate: campaign.data.plan_gate || "human",
    landing: campaign.data.landing || "branch",
    base: campaign.data.base || "main",
    runner,
    budget: campaign.data.budget || null,
    maxAutoshipLines: campaign.data.max_autoship_lines ?? 200,
    quotas: resolveQuotas(consoleConfig, campaign.data),
    campaignQuotas: campaign.data.quotas || [],
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
        { models: (kind.models || []).map((m) => ({ adapter: m.adapter || null, model: m.model, thinking: m.thinking || null })) },
      ]),
    ),
    effectiveKinds: Object.fromEntries(
      Object.entries(effectiveKinds).map(([id, kind]) => [
        id,
        {
          label: kind.label,
          description: kind.description,
          models: kind.models.map((m) => ({ adapter: m.adapter || null, model: m.model, thinking: m.thinking || null })),
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
