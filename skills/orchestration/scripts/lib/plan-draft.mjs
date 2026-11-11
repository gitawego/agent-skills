// Draft plans: the chat's review surface before anything is written.
//
// `plan draft` stores the current proposal beside the campaign state, keeps
// the previous draft for a “since your last message” delta, and compares both
// against what is currently applied. Nothing here writes tickets.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  UserError,
  campaignStateDir,
  ensureDir,
  exists,
  nowIso,
  pad2,
  readJson,
  readText,
  writeJson,
} from "./util.mjs";
import { readCampaign, sections } from "./config.mjs";
import { asArray, loadTickets, ticketTitle, touchesOverlap } from "./plan.mjs";
import { PLAN_LIMITS, normalizePlan, parsePlanText, planFragmentation } from "./plan-import.mjs";
import { stringifyYaml } from "./yaml.mjs";

const CAMPAIGN_COMPARE = ["goal", "brief", "criteria", "constraints", "assumptions", "open_questions", "reading"];
const TICKET_COMPARE = ["title", "kind", "blocked_by", "touches", "what", "accept", "attachments", "sources", "notes"];

const RISK_PATHS = [
  /(^|\/)(auth|authn|authz|payments?|billing|migrations?|secrets?|infra|terraform|helm|k8s)(?=$|[/_.-])/i,
];

export function draftFile(root, slug) {
  return path.join(campaignStateDir(root, slug), "plan.yml");
}

export function previousDraftFile(root, slug) {
  return path.join(campaignStateDir(root, slug), "plan.prev.yml");
}

export function appliedPlanFile(root, slug) {
  return path.join(campaignStateDir(root, slug), "plan.applied.yml");
}

export function appliedAuditFile(root, slug) {
  return path.join(campaignStateDir(root, slug), "plan.applied.json");
}

export function planHash(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 12);
}

export function canonicalPlan(plan) {
  return {
    version: 1,
    goal: plan.goal,
    brief: plan.brief,
    criteria: plan.criteria,
    constraints: plan.constraints,
    assumptions: plan.assumptions,
    open_questions: plan.open_questions,
    reading: plan.reading,
    tickets: plan.tickets.map((ticket) => ({
      key: ticket.key,
      title: ticket.title,
      kind: ticket.kind,
      blocked_by: ticket.blocked_by,
      touches: ticket.touches,
      what: ticket.what,
      accept: ticket.accept,
      attachments: ticket.attachments,
      sources: ticket.sources,
      notes: ticket.notes,
    })),
  };
}

export function canonicalText(plan) {
  return stringifyYaml(canonicalPlan(plan));
}

function readDoc(file, { allowedKinds = null, strict = true } = {}) {
  if (!exists(file)) return null;
  const text = readText(file, "");
  try {
    const parsed = parsePlanText(text);
    const plan = normalizePlan(parsed, { allowedKinds, requireAssumptions: false });
    return { file, text, plan, hash: planHash(text), error: null };
  } catch (err) {
    if (strict) throw err;
    return { file, text, plan: null, hash: planHash(text), error: err.message };
  }
}

export function readDraft(root, slug, options = {}) {
  const file = draftFile(root, slug);
  const doc = readDoc(file, { allowedKinds: options.allowedKinds || null, strict: Boolean(options.strict) });
  if (!doc) return { exists: false, file, text: "", plan: null, hash: null, error: null, updatedAt: null };
  const stat = fs.statSync(file);
  return {
    exists: true,
    file,
    text: doc.text,
    plan: doc.plan,
    hash: doc.hash,
    error: doc.error,
    updatedAt: stat.mtime.toISOString(),
  };
}

export function readPreviousDraft(root, slug, options = {}) {
  const file = previousDraftFile(root, slug);
  const doc = readDoc(file, { allowedKinds: options.allowedKinds || null, strict: false });
  if (!doc) return { exists: false, file, text: "", plan: null, hash: null, error: null };
  return { exists: true, file, text: doc.text, plan: doc.plan, hash: doc.hash, error: doc.error };
}

function cleanSection(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => line !== "None.");
}

function criteriaFromSection(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.match(/^\s*-\s*\[( |x|X)\]\s*(.+)$/))
    .filter(Boolean)
    .map((match) => match[2].trim());
}

/* The applied base for a campaign that predates plan.applied.yml: derive it
   from the committed campaign document and ticket files. */
export function currentPlan(root, slug) {
  const campaign = readCampaign(root, slug);
  const tickets = loadTickets(root, slug);
  const byId = new Map();
  for (const ticket of tickets) {
    if (ticket.data.id) byId.set(pad2(ticket.data.id), String(ticket.data.key || ticket.slug));
  }
  const plan = {
    version: 1,
    goal: (campaign.sections.goal || "").trim(),
    brief: (campaign.sections.brief || "").trim(),
    criteria: criteriaFromSection(campaign.sections["acceptance criteria"]),
    constraints: (campaign.sections.constraints || "").trim(),
    assumptions: cleanSection(campaign.sections.assumptions),
    open_questions: cleanSection(campaign.sections["open questions"]),
    reading: (campaign.sections["what to read first"] || "").trim(),
    tickets: tickets.map((ticket) => ({
      key: String(ticket.data.key || ticket.slug),
      title: ticketTitle(ticket),
      kind: String(ticket.data.kind || ""),
      blocked_by: asArray(ticket.data.blocked_by).map((id) => byId.get(pad2(id)) || pad2(id)),
      touches: asArray(ticket.data.touches),
      what: ticket.what,
      accept: ticket.criteria.map((criterion) => criterion.text),
      attachments: asArray(ticket.data.attachments),
      sources: asArray(ticket.data.sources),
      notes: ticket.notes,
    })),
  };
  return normalizePlan(plan, { requireAssumptions: false, allowEmpty: true });
}

export function readAppliedBase(root, slug) {
  const file = appliedPlanFile(root, slug);
  const doc = readDoc(file, { strict: false });
  if (doc?.plan) return { ...doc, source: "applied" };
  return { file, text: "", plan: currentPlan(root, slug), hash: null, error: doc?.error || null, source: "tickets" };
}

export function readAppliedAudit(root, slug) {
  return readJson(appliedAuditFile(root, slug), null);
}

export function persistAppliedAudit(root, slug, audit) {
  writeJson(appliedAuditFile(root, slug), audit);
  return audit;
}

/* Older campaigns predate plan.applied.json. Derive the same audit shape from
   the applied plan (or the committed ticket graph) without writing anything. */
export function deriveAppliedAudit(root, slug, { appliedAt = null } = {}) {
  const applied = readAppliedBase(root, slug);
  const tickets = loadTickets(root, slug);
  if (!applied.plan || (!tickets.length && !applied.text)) return null;
  const byKey = new Map(tickets.map((ticket) => [String(ticket.data.key || ticket.slug), ticket]));
  const rows = applied.plan.tickets.map((ticket, index) => {
    const actual = byKey.get(ticket.key);
    return {
      id: actual?.data.id || pad2(index + 1),
      key: ticket.key,
      title: actual ? ticketTitle(actual) : ticket.title,
      kind: actual?.data.kind || ticket.kind,
    };
  });
  const seen = new Set(rows.map((ticket) => ticket.key));
  for (const ticket of tickets) {
    const key = String(ticket.data.key || ticket.slug);
    if (seen.has(key)) continue;
    rows.push({ id: ticket.data.id, key, title: ticketTitle(ticket), kind: ticket.data.kind });
  }
  const text = applied.text || canonicalText(applied.plan);
  return {
    version: 1,
    hash: planHash(text),
    appliedAt: appliedAt || null,
    derived: true,
    tickets: rows,
    assumptions: applied.plan.assumptions || [],
    openQuestions: applied.plan.open_questions || [],
  };
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sorted(value) {
  return [...asArray(value)].map(String).sort();
}

function ticketChanges(basePlan, nextPlan) {
  const base = new Map((basePlan?.tickets || []).map((ticket) => [ticket.key, ticket]));
  const next = (nextPlan?.tickets || []).map((ticket) => [ticket.key, ticket]);
  const added = [];
  const changed = [];
  let unchanged = 0;
  for (const [key, ticket] of next) {
    const before = base.get(key);
    if (!before) {
      added.push({ key, title: ticket.title, kind: ticket.kind });
      continue;
    }
    const fields = TICKET_COMPARE.filter((name) => {
      if (name === "touches" || name === "attachments" || name === "sources") return !sameValue(sorted(ticket[name]), sorted(before[name]));
      if (name === "blocked_by") return !sameValue(sorted(ticket[name]), sorted(before[name]));
      return !sameValue(ticket[name], before[name]);
    });
    if (fields.length) changed.push({ key, title: ticket.title, kind: ticket.kind, fields });
    else unchanged++;
  }
  const nextKeys = new Set(next.map(([key]) => key));
  const removed = [...base.entries()]
    .filter(([key]) => !nextKeys.has(key))
    .map(([key, ticket]) => ({ key, title: ticket.title, kind: ticket.kind }));
  return { added, removed, changed, unchanged, tickets: next.length };
}

export function diffPlans(basePlan, nextPlan) {
  const campaign = CAMPAIGN_COMPARE.filter((name) => !sameValue(basePlan?.[name], nextPlan?.[name]));
  return {
    campaign,
    ...ticketChanges(basePlan, nextPlan),
  };
}

export function planWarnings({ plan, contextBytes = 0, maxConcurrent = 4 }) {
  const warnings = [];
  if (plan.tickets.length > PLAN_LIMITS.warnTickets) {
    warnings.push({
      level: "warn",
      code: "ticket-count",
      text: `${plan.tickets.length} tickets is above the ${PLAN_LIMITS.warnTickets}-ticket review threshold; split the campaign if the graph is hard to read.`,
    });
  }
  if (contextBytes > PLAN_LIMITS.warnContextBytes) {
    warnings.push({
      level: "warn",
      code: "context-size",
      text: `context.md is ${Math.round(contextBytes / 1024)} KB; consider summarizing it before planning.`,
    });
  }
  const frontier = plan.tickets.filter((ticket) => !ticket.blocked_by.length).length;
  if (frontier > maxConcurrent) {
    warnings.push({
      level: "warn",
      code: "frontier",
      text: `${frontier} tickets have no blockers, above the ${maxConcurrent}-slot cap; the rest will queue.`,
    });
  }
  for (const ticket of plan.tickets) {
    for (const touch of ticket.touches) {
      if (RISK_PATHS.some((pattern) => pattern.test(touch))) {
        warnings.push({
          level: "warn",
          code: "risk-path",
          text: `ticket ${ticket.key} touches ${touch}; high-risk path, review it explicitly.`,
        });
        break;
      }
    }
    if (!ticket.sources.length) {
      warnings.push({
        level: "info",
        code: "sources",
        text: `ticket ${ticket.key} cites no sources; add the files or context it came from when you can.`,
      });
    }
  }
  const overlaps = [];
  for (let i = 0; i < plan.tickets.length; i++) {
    for (let j = i + 1; j < plan.tickets.length; j++) {
      if (touchesOverlap(plan.tickets[i].touches, plan.tickets[j].touches)) {
        overlaps.push(`${plan.tickets[i].key}/${plan.tickets[j].key}`);
      }
    }
  }
  if (overlaps.length) {
    warnings.push({
      level: "warn",
      code: "overlap",
      text: `${overlaps.length} ticket pair${overlaps.length === 1 ? "" : "s"} overlap (${overlaps.slice(0, 3).join(", ")}); the scheduler will serialize them.`,
    });
  }
  const fragmentation = planFragmentation(plan);
  if (fragmentation.small.length >= 3) {
    warnings.push({
      level: "warn",
      code: "fragmentation",
      text: `${fragmentation.small.length} of ${plan.tickets.length} tickets touch one path and have one acceptance criterion (${fragmentation.small.join(", ")}); merge small neighbors unless each is independently verifiable.`,
    });
  }
  if (fragmentation.mergeCandidates.length) {
    warnings.push({
      level: "warn",
      code: "merge-candidates",
      text: `${fragmentation.mergeCandidates.length} merge candidate pair${fragmentation.mergeCandidates.length === 1 ? "" : "s"} (${fragmentation.mergeCandidates.slice(0, 3).join(", ")}): same or nested paths behind a dependency.`,
    });
  }
  if (fragmentation.chain >= 4) {
    warnings.push({
      level: "warn",
      code: "serial-chain",
      text: `The graph is one ${fragmentation.chain}-ticket chain; merge adjacent slices or split the work so more than one ticket can run in parallel.`,
    });
  }
  if (plan.open_questions.length) {
    warnings.push({
      level: "warn",
      code: "open-questions",
      text: `${plan.open_questions.length} open question${plan.open_questions.length === 1 ? "" : "s"} block import until answered or --accept-open is passed.`,
    });
  }
  return warnings;
}

function writePrevious(root, slug, text) {
  if (text == null) return;
  const file = previousDraftFile(root, slug);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text);
}

export function draftPlan({ root, slug, plan, allowedKinds = null, maxConcurrent = 4, contextBytes = 0 }) {
  const normalized = normalizePlan(plan, { allowedKinds });
  const previous = readDraft(root, slug, { allowedKinds });
  const applied = readAppliedBase(root, slug);
  const warnings = planWarnings({ plan: normalized, contextBytes, maxConcurrent });
  const text = canonicalText(normalized);
  const file = draftFile(root, slug);
  ensureDir(path.dirname(file));
  if (previous.exists) writePrevious(root, slug, previous.text);
  fs.writeFileSync(file, text);
  const deltaPrevious = previous.plan ? diffPlans(previous.plan, normalized) : null;
  return {
    file,
    previousFile: previousDraftFile(root, slug),
    appliedFile: appliedPlanFile(root, slug),
    hash: planHash(text),
    text,
    plan: normalized,
    previous: previous.exists ? previous.plan : null,
    applied: applied.plan,
    deltaPrevious,
    deltaApplied: diffPlans(applied.plan, normalized),
    fragmentation: planFragmentation(normalized),
    warnings,
  };
}

export function refreshDraft(root, slug, { allowedKinds = null, maxConcurrent = 4, contextBytes = 0 } = {}) {
  const draft = readDraft(root, slug, { allowedKinds, strict: true });
  if (!draft.exists) throw new UserError(`No draft plan for "${slug}"`, [`Run \`orchestrate plan draft ${slug} --file plan.yml\`.`]);
  if (draft.error) throw new UserError(`The draft plan is invalid: ${draft.error}`);
  const previous = readPreviousDraft(root, slug, { allowedKinds });
  const applied = readAppliedBase(root, slug);
  return {
    ...draft,
    previous: previous.plan,
    applied: applied.plan,
    deltaPrevious: previous.plan ? diffPlans(previous.plan, draft.plan) : null,
    deltaApplied: diffPlans(applied.plan, draft.plan),
    fragmentation: planFragmentation(draft.plan),
    warnings: planWarnings({ plan: draft.plan, contextBytes, maxConcurrent }),
  };
}

export function discardDraft(root, slug) {
  const files = [draftFile(root, slug), previousDraftFile(root, slug)];
  const removed = [];
  for (const file of files) {
    if (!exists(file)) continue;
    fs.unlinkSync(file);
    removed.push(file);
  }
  return removed;
}

export function writeApplied({ root, slug, plan, result }) {
  const file = appliedPlanFile(root, slug);
  const text = canonicalText(plan);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text);
  const audit = {
    version: 1,
    hash: planHash(text),
    appliedAt: nowIso(),
    tickets: result.tickets.map((ticket) => ({
      id: ticket.id,
      key: ticket.key,
      title: ticket.title,
      kind: ticket.kind,
    })),
    assumptions: plan.assumptions,
    openQuestions: plan.open_questions,
  };
  writeJson(appliedAuditFile(root, slug), audit);
  return audit;
}

function deltaLine(delta, label) {
  if (!delta) return `${label}: first draft`;
  const parts = [`+${delta.added.length}`, `~${delta.changed.length}`, `-${delta.removed.length}`];
  return `${label}: ${parts.join(" ")}`;
}

function deltaDetails(delta) {
  if (!delta) return [];
  const lines = [];
  for (const ticket of delta.added) lines.push(`  + ${ticket.key}  ${ticket.title} [${ticket.kind}]`);
  for (const ticket of delta.changed) lines.push(`  ~ ${ticket.key}  ${ticket.fields.join(", ")}`);
  for (const ticket of delta.removed) lines.push(`  - ${ticket.key}  ${ticket.title}`);
  if (delta.campaign.length) lines.push(`  campaign: ${delta.campaign.join(", ")}`);
  return lines;
}

export function formatPlanDiff(result, { label = "Plan draft" } = {}) {
  const lines = [];
  const count = result.plan.tickets.length;
  const fragmentation = result.fragmentation || planFragmentation(result.plan);
  const frontier = result.plan.tickets.filter((ticket) => !ticket.blocked_by.length).length;
  lines.push(`${label} · ${count} ticket${count === 1 ? "" : "s"} · ${result.hash || "unsaved"}`);
  lines.push(
    `Runs: ~${count * 2} (${count} work + ${count} review) before retries · ${frontier} ready to start · ${fragmentation.small.length} small · ${fragmentation.mergeCandidates.length} merge candidate${fragmentation.mergeCandidates.length === 1 ? "" : "s"}`,
  );
  lines.push(deltaLine(result.deltaPrevious, "Since your last draft"));
  lines.push(...deltaDetails(result.deltaPrevious));
  lines.push(deltaLine(result.deltaApplied, "Apply will change"));
  lines.push(...deltaDetails(result.deltaApplied));
  if (result.deltaApplied?.removed?.length) {
    lines.push("  (marked - remain unless `plan import --prune` is used)");
  }
  if (result.plan.assumptions.length) {
    lines.push("Assumptions:");
    for (const assumption of result.plan.assumptions) lines.push(`  - ${assumption}`);
  }
  if (result.plan.open_questions.length) {
    lines.push("Open questions:");
    for (const question of result.plan.open_questions) lines.push(`  - ${question}`);
  }
  if (result.warnings.length) {
    lines.push("Warnings:");
    for (const warning of result.warnings) lines.push(`  ! ${warning.text}`);
  }
  return lines.join("\n");
}
