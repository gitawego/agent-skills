// A compact, evidence-bound handoff for a worker or subagent.
//
// This is not a transcript summary. It carries only the facts that already
// have a source, the decisions that bind the ticket, and pointers to the
// material a reader may fetch when it needs more. Everything is bounded.
import { asArray, ticketTitle } from "./plan.mjs";
import { clip } from "./util.mjs";

export const PACKET_LIMITS = {
  dependencies: 8,
  decisions: 12,
  facts: 20,
  text: 600,
  evidence: 400,
  path: 300,
};

function cleanSection(value) {
  const text = String(value || "").trim();
  return text === "None." ? "" : text;
}

function listSection(value) {
  return cleanSection(value)
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

function ticketEntry(ticket) {
  if (!ticket) return null;
  return {
    id: ticket.data.id,
    key: ticket.data.key || null,
    title: ticketTitle(ticket),
    kind: ticket.data.kind,
    what: clip(ticket.what, PACKET_LIMITS.text, "ticket body truncated"),
    acceptance: ticket.criteria.map((criterion) => clip(criterion.text, PACKET_LIMITS.path, "criterion truncated")),
    paths: asArray(ticket.data.touches).map((path) => clip(path, PACKET_LIMITS.path, "path truncated")),
    blocked_by: asArray(ticket.data.blocked_by).map((id) => String(id).padStart(2, "0")),
    covers: asArray(ticket.data.covers).map((criterion) => clip(criterion, PACKET_LIMITS.path, "criterion truncated")),
    sources: asArray(ticket.data.sources).map((path) => clip(path, PACKET_LIMITS.path, "path truncated")),
  };
}

function dependencyEntry(ticket, state, blockerId) {
  const blocker = ticket && state.tickets[blockerId];
  if (!blocker) return null;
  return {
    id: blockerId,
    title: ticket ? ticketTitle(ticket) : blockerId,
    summary: clip(blocker.summary || "", PACKET_LIMITS.text, "summary truncated"),
    touched: asArray(blocker.actualTouches).map((path) => clip(path, PACKET_LIMITS.path, "path truncated")),
    checks: asArray(blocker.checks).map((check) => ({
      name: String(check.name || "check"),
      ok: check.ok !== false,
    })),
    next: blocker.next ? clip(blocker.next, PACKET_LIMITS.text, "handoff truncated") : "",
    acceptance: asArray(blocker.acceptance).map((result) => ({
      criterion: clip(result.criterion, PACKET_LIMITS.path, "criterion truncated"),
      status: result.status || "reported",
      ...(result.evidence ? { evidence: clip(result.evidence, PACKET_LIMITS.evidence, "evidence truncated") } : {}),
    })),
  };
}

/* `ticket` is a loaded ticket object; `plan` is loadPlan's result. The packet
   never invents a fact: verified facts come only from passed acceptance
   evidence, and every other field is a pointer or a recorded decision. */
export function buildContextPacket({ campaign, plan, state, ticket = null, decisions = [], stats = null, inbox = [] }) {
  const deps = [];
  for (const id of asArray(ticket?.data?.blocked_by).map((value) => String(value).padStart(2, "0"))) {
    const blocker = plan.byId.get(id);
    const entry = dependencyEntry(blocker, state, id);
    if (entry) deps.push(entry);
    if (deps.length >= PACKET_LIMITS.dependencies) break;
  }

  const verifiedFacts = [];
  for (const dependency of deps) {
    for (const result of dependency.acceptance) {
      if (result.status !== "passed" || !result.evidence) continue;
      verifiedFacts.push({
        id: `F-${dependency.id}-${verifiedFacts.length + 1}`,
        claim: result.criterion,
        evidence: result.evidence,
        source: `ticket ${dependency.id} acceptance`,
        status: "passed",
      });
      if (verifiedFacts.length >= PACKET_LIMITS.facts) break;
    }
    if (verifiedFacts.length >= PACKET_LIMITS.facts) break;
  }

  const commandsRun = deps.flatMap((dependency) =>
    dependency.checks.map((check) => ({
      ticket: dependency.id,
      command: check.name,
      result: check.ok ? "pass" : "fail",
      source: "worker report",
    })),
  );

  const decisionRows = asArray(decisions)
    .slice(-PACKET_LIMITS.decisions)
    .map((record) => ({
      id: record.id || null,
      text: clip(record.text || "", PACKET_LIMITS.text, "decision truncated"),
      ...(record.cite ? { cite: record.cite } : {}),
      ...(record.by ? { by: record.by } : {}),
      ...(record.ticket ? { ticket: record.ticket } : {}),
    }));

  const openQuestions = [
    ...listSection(campaign.sections?.["open questions"]),
    ...asArray(inbox)
      .filter((item) => item.status === "open" && (item.kind === "question" || item.kind === "needs_answer"))
      .map((item) => item.question?.text || item.title || ""),
  ].filter(Boolean);

  const readFirst = [
    ...asArray(ticket?.data?.sources),
    ...deps.flatMap((dependency) => dependency.touched),
  ]
    .map((path) => String(path))
    .filter(Boolean)
    .filter((path, index, all) => all.indexOf(path) === index)
    .slice(0, 24);

  const doNotRecheck = [
    ...verifiedFacts.map((fact) => fact.claim),
    ...decisionRows.map((decision) => decision.text),
  ];

  return {
    version: 1,
    campaign: campaign.slug,
    goal: (campaign.sections?.goal || "").trim(),
    ticket: ticketEntry(ticket),
    dependencies: deps,
    verified_facts: verifiedFacts,
    decisions: decisionRows,
    artifacts: deps.flatMap((dependency) =>
      dependency.touched.map((path) => ({ path, ticket: dependency.id })),
    ).slice(0, 32),
    commands_run: commandsRun,
    do_not_recheck: doNotRecheck,
    open_questions: [...new Set(openQuestions)],
    read_first: readFirst,
    ...(stats ? { integration: stats } : {}),
  };
}
