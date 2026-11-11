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
import { readContext } from "./plan-import.mjs";
import { readAppliedAudit, readDraft } from "./plan-draft.mjs";

export function projectName(root) {
  return path.basename(root);
}

function cleanSection(value) {
  const text = String(value || "").trim();
  return text === "None." ? "" : text;
}

/* What the panel should point at next. The panel never decides this with a
   model; it reads the same state the supervisor writes. */
export function deriveNextAction({ slug, stage, tickets = [], inbox = [], planErrors = [], reason = null, unboundKinds = [], draft = null }) {
  const open = inbox.filter((item) => item.status === "open");
  const review = open.find((item) => item.kind === "review");
  const question = open.find((item) => item.kind === "needs_answer");
  const failure = open.find((item) => item.kind === "failure");
  if (stage === "archived") return { actor: "none", text: "The record is closed.", command: null };
  if (stage === "delivered") {
    return { actor: "you", text: "Close the campaign with a report.", command: `orchestrate archive ${slug}` };
  }
  if (review) {
    return {
      actor: "you",
      text: "A delivery is waiting for review.",
      command: `orchestrate review ${review.id} approve "…"`,
    };
  }
  if (question) {
    return {
      actor: "worker",
      text: `Ticket ${question.ticket || "?"} is waiting for a decision.`,
      command: `orchestrate answer ${question.id} "…"`,
    };
  }
  if (failure) {
    return {
      actor: "you",
      text: failure.title || "A run failed and needs a person.",
      command: "orchestrate inbox",
    };
  }
  if (stage === "paused") {
    return {
      actor: "you",
      text: reason ? `Paused: ${reason}.` : "Paused. Resume or re-plan.",
      command: `orchestrate resume ${slug}`,
    };
  }
  if (stage === "running") {
    return { actor: "supervisor", text: "Supervisor is dispatching the frontier.", command: null };
  }
  if (draft?.exists) {
    if (draft.error) {
      return {
        actor: "you",
        text: "The draft plan is invalid; fix it in your agent session.",
        command: `orchestrate plan show ${slug}`,
      };
    }
    return {
      actor: "you",
      text: "Review the draft plan in your agent session.",
      command: `orchestrate plan diff ${slug}`,
    };
  }
  if (stage === "awaiting_approval") {
    return { actor: "you", text: "Approve the plan and bindings.", command: `orchestrate approve ${slug}` };
  }
  if (!tickets.length) {
    return {
      actor: "you",
      text: "Write the plan in your agent session.",
      command: `orchestrate plan draft ${slug} --file plan.yml`,
    };
  }
  if (unboundKinds.length) {
    return {
      actor: "you",
      text: `Bind the model chain${unboundKinds.length === 1 ? "" : "s"} for ${unboundKinds.join(", ")}.`,
      command: `orchestrate defaults ${slug} --apply`,
    };
  }
  if (planErrors.some((error) => /has no model chain/.test(error))) {
    return {
      actor: "you",
      text: "Bind the model chains.",
      command: `orchestrate defaults ${slug} --apply`,
    };
  }
  if (planErrors.length) {
    return {
      actor: "you",
      text: "Fix the plan errors in your agent session.",
      command: `orchestrate plan ${slug}`,
    };
  }
  return { actor: "you", text: "Approve the plan and bindings.", command: `orchestrate approve ${slug}` };
}

function spendByModel(runs) {
  const map = new Map();
  for (const run of runs) {
    if (!run.model) continue;
    const key = `${run.adapter || "?"} · ${run.model}`;
    const entry = map.get(key) || {
      model: key,
      runs: 0,
      tokens: 0,
      dollars: 0,
      cachedReadTokens: 0,
      promptTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    entry.runs += 1;
    entry.tokens += Number(run.totalTokens || run.tokens || 0);
    entry.dollars += Number(run.dollars || 0);
    entry.cachedReadTokens += Number(run.cachedReadTokens || 0);
    entry.promptTokens += Number(run.promptTokens || 0);
    entry.inputTokens += Number(run.inputTokens || 0);
    entry.outputTokens += Number(run.outputTokens || 0);
    map.set(key, entry);
  }
  return [...map.values()]
    .map((entry) => ({
      ...entry,
      cacheHit: entry.promptTokens ? entry.cachedReadTokens / entry.promptTokens : null,
    }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
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

  const inboxItems = listItems(root, slug);
  const context = readContext(root, slug);
  const draft = readDraft(root, slug);
  const planAudit = readAppliedAudit(root, slug);
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
      sources: asArray(ticket.data.sources),
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
    assumptions: cleanSection(campaign.sections.assumptions),
    openQuestions: cleanSection(campaign.sections["open questions"]),
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
    approvedAt: state.approvedAt || null,
    planAudit,
    draft: {
      exists: draft.exists,
      file: draft.file,
      hash: draft.hash,
      updatedAt: draft.updatedAt,
      error: draft.error,
      tickets: draft.plan ? draft.plan.tickets.length : 0,
      assumptions: draft.plan ? draft.plan.assumptions.length : 0,
      openQuestions: draft.plan ? draft.plan.open_questions.length : 0,
      goal: draft.plan?.goal || "",
      brief: draft.plan?.brief || "",
      criteria: draft.plan?.criteria || [],
      constraints: draft.plan?.constraints || "",
      reading: draft.plan?.reading || "",
      assumptionsList: draft.plan?.assumptions || [],
      openQuestionsList: draft.plan?.open_questions || [],
      ticketsList: (draft.plan?.tickets || []).map((ticket) => ({
        key: ticket.key,
        title: ticket.title,
        kind: ticket.kind,
        blocked_by: ticket.blocked_by,
        sources: ticket.sources,
      })),
    },
    context: {
      file: context.file,
      bytes: context.bytes,
      updatedAt: context.updatedAt,
      truncated: context.text.length > 24_000,
      text: context.text.length > 24_000 ? `${context.text.slice(0, 24_000)}\n\n… truncated …` : context.text,
    },
    counts: tickets.reduce((acc, ticket) => {
      acc[ticket.stage] = (acc[ticket.stage] || 0) + 1;
      return acc;
    }, {}),
    spendByModel: spendByModel(runs),
    cacheHit: (() => {
      const cached = runs.reduce((n, run) => n + Number(run.cachedReadTokens || 0), 0);
      const prompt = runs.reduce((n, run) => n + Number(run.promptTokens || 0), 0);
      return prompt ? cached / prompt : null;
    })(),
    tickets,
    runs,
    inbox: inboxItems,
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
    nextAction: deriveNextAction({
      slug,
      stage: state.stage,
      tickets,
      inbox: inboxItems,
      planErrors: state.planErrors || [],
      reason: state.reason,
      draft: { exists: draft.exists, error: draft.error },
      unboundKinds: [...new Set(tickets.map((ticket) => ticket.kind))].filter(
        (kind) => !(effectiveKinds[kind]?.models || []).length,
      ),
    }),
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
