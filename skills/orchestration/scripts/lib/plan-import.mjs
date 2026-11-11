// Free-form context and the atomic plan import.
//
// The human talks to the agent; the agent writes `context.md` and then a plan
// file. This module is the only writer of the campaign body and the ticket
// graph from that plan. It validates everything first, writes, then re-reads
// the plan and restores the previous files if the result is invalid.
import fs from "node:fs";
import path from "node:path";
import { UserError, ensureDir, exists, nowIso, pad2, readText } from "./util.mjs";
import { readCampaign } from "./config.mjs";
import { asArray, loadPlan, loadTickets, ticketsDir, touchesOverlap } from "./plan.mjs";
import { joinFrontmatter, parseYaml } from "./yaml.mjs";
import { slugify } from "./create.mjs";

export const PLAN_LIMITS = { warnTickets: 8, maxTickets: 16, warnContextBytes: 100_000 };

const PLAN_FIELDS = new Set([
  "version",
  "goal",
  "brief",
  "criteria",
  "constraints",
  "assumptions",
  "open_questions",
  "reading",
  "tickets",
]);
const TICKET_FIELDS = new Set([
  "key",
  "title",
  "kind",
  "blocked_by",
  "touches",
  "what",
  "accept",
  "attachments",
  "sources",
  "notes",
]);
const STANDARD_SECTIONS = new Set([
  "goal",
  "brief",
  "acceptance criteria",
  "constraints",
  "assumptions",
  "open questions",
  "what to read first",
]);

export function contextFile(root, slug) {
  return path.join(root, "orchestration", slug, "context.md");
}

export function readContext(root, slug) {
  const file = contextFile(root, slug);
  if (!exists(file)) return { text: "", bytes: 0, updatedAt: null, file };
  const text = readText(file, "");
  const stat = fs.statSync(file);
  return { text, bytes: Buffer.byteLength(text, "utf8"), updatedAt: stat.mtime.toISOString(), file };
}

export function appendContext({ root, slug, text, source = "human" }) {
  readCampaign(root, slug);
  const body = String(text ?? "").trim();
  if (!body) throw new UserError("Context is empty", ["Paste a note, a link, or a constraint."]);
  const file = contextFile(root, slug);
  ensureDir(path.dirname(file));
  const previous = exists(file) ? readText(file, "") : "";
  const stamp = nowIso();
  const block = `## ${stamp} · ${source}\n\n${body}\n`;
  const next = `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${previous ? "\n" : ""}${block}`;
  fs.writeFileSync(file, next);
  return { file, bytes: Buffer.byteLength(body, "utf8"), at: stamp, total: Buffer.byteLength(next, "utf8") };
}

export function parsePlanText(text) {
  try {
    return parseYaml(String(text || ""));
  } catch (err) {
    throw new UserError(`The plan is not valid YAML: ${err.message}`, [
      "Write the plan with goal, brief and a tickets list; run `orchestrate plan import ... --json` to see errors.",
    ]);
  }
}

function stringList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value)
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*(\[\s*\])?\s*/, "").trim())
    .filter(Boolean);
}

function textBlock(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join("\n");
  return String(value).trim();
}

function normalizeKey(value, title, used) {
  const base = slugify(value || title) || "ticket";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  used.add(`${base}-${n}`);
  return `${base}-${n}`;
}

function checkAttachment(value) {
  const file = String(value);
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
    throw new UserError(`attachment "${file}" must be a path inside the project`);
  if (!/\.(png|jpe?g|webp|gif|pdf)$/i.test(file))
    throw new UserError(`attachment "${file}" is not a supported file (png, jpeg, webp, gif, pdf)`);
  return file;
}

export function normalizePlan(plan, { allowedKinds = null, requireAssumptions = true, allowEmpty = false } = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan))
    throw new UserError("A plan is an object with goal, brief and tickets");
  for (const key of Object.keys(plan)) {
    if (!PLAN_FIELDS.has(key))
      throw new UserError(`Unknown plan field "${key}"`, [
        "version, goal, brief, criteria, constraints, assumptions, open_questions, reading, tickets",
      ]);
  }
  if (plan.version != null && Number(plan.version) !== 1)
    throw new UserError(`Unsupported plan version "${plan.version}"`, ["Use version: 1."]);
  const goal = String(plan.goal || "").trim();
  if (!goal) throw new UserError("A plan needs a goal");
  if (requireAssumptions && plan.assumptions == null) {
    throw new UserError("A plan needs an assumptions list", [
      "Use `assumptions: []` when there is nothing to assume; the list is where the agent states what it inferred.",
    ]);
  }
  const specs = Array.isArray(plan.tickets) ? plan.tickets : [];
  if (!specs.length && !allowEmpty) throw new UserError("A plan needs at least one ticket");
  if (specs.length > PLAN_LIMITS.maxTickets)
    throw new UserError(`A plan may contain at most ${PLAN_LIMITS.maxTickets} tickets`, [
      `Split it into smaller campaigns, or merge tickets until it is under ${PLAN_LIMITS.maxTickets}.`,
    ]);
  const usedKeys = new Set();
  const tickets = specs.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new UserError(`ticket ${index + 1} is not an object`);
    for (const key of Object.keys(raw)) {
      if (!TICKET_FIELDS.has(key)) throw new UserError(`ticket ${index + 1}: unknown field "${key}"`);
    }
    const title = String(raw.title || "").trim();
    if (!title) throw new UserError(`ticket ${index + 1} has no title`);
    const kind = String(raw.kind || "").trim();
    if (!kind) throw new UserError(`ticket "${title}" has no kind`);
    if (allowedKinds && !allowedKinds.includes(kind))
      throw new UserError(`ticket "${title}" has unknown kind "${kind}"`, [`one of ${allowedKinds.join(", ")}`]);
    const touches = stringList(raw.touches);
    if (!touches.length) throw new UserError(`ticket "${title}" has no touches`);
    const accept = stringList(raw.accept);
    if (!accept.length) throw new UserError(`ticket "${title}" has no acceptance criteria`);
    const attachments = stringList(raw.attachments).map(checkAttachment);
    return {
      key: normalizeKey(raw.key, title, usedKeys),
      title,
      kind,
      blocked_by: asArray(raw.blocked_by).map((value) => String(value).trim()).filter(Boolean),
      touches,
      what: String(raw.what || "").trim() || title,
      accept,
      attachments,
      sources: stringList(raw.sources),
      notes: String(raw.notes || "").trim(),
    };
  });
  /* Numeric blockers are assigned ids in file order. Normalize them to the
     stable ticket key so a later revision can reorder the file without
     silently re-pointing a dependency. */
  const byId = new Map(tickets.map((ticket, index) => [pad2(index + 1), ticket.key]));
  for (const ticket of tickets) {
    ticket.blocked_by = ticket.blocked_by.map((ref) => byId.get(pad2(ref)) || ref);
  }
  return {
    goal,
    brief: textBlock(plan.brief),
    criteria: stringList(plan.criteria),
    constraints: textBlock(plan.constraints),
    assumptions: stringList(plan.assumptions),
    open_questions: stringList(plan.open_questions),
    reading: textBlock(plan.reading),
    tickets,
  };
}

/* A slice is “small” when it has one touched path and one acceptance
   criterion. Four or more small slices in a plan is fragmentation, not
   decomposition: each one pays for a worktree, a work run and a review run. */
export function planFragmentation(plan) {
  const tickets = plan.tickets || [];
  const small = tickets.filter((ticket) => ticket.touches.length <= 1 && ticket.accept.length <= 1);
  const ratio = tickets.length ? small.length / tickets.length : 0;
  const byTouches = new Map();
  for (const ticket of tickets) {
    const key = [...ticket.touches].map(String).sort().join("\u0000");
    if (!byTouches.has(key)) byTouches.set(key, []);
    byTouches.get(key).push(ticket.key);
  }
  const candidates = new Set();
  for (const keys of byTouches.values()) {
    if (keys.length < 2) continue;
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) candidates.add([keys[i], keys[j]].sort().join("/"));
  }
  for (const left of tickets) {
    for (const right of tickets) {
      if (left.key >= right.key) continue;
      const blocked = left.blocked_by.includes(right.key) || right.blocked_by.includes(left.key);
      if (!blocked) continue;
      const subset =
        left.touches.every((touch) => right.touches.some((other) => touchesOverlap([touch], [other]))) ||
        right.touches.every((touch) => left.touches.some((other) => touchesOverlap([touch], [other])));
      if (subset) candidates.add([left.key, right.key].sort().join("/"));
    }
  }
  const byKey = new Map(tickets.map((ticket) => [ticket.key, ticket]));
  const depth = new Map();
  const longest = (ticket) => {
    if (depth.has(ticket.key)) return depth.get(ticket.key);
    depth.set(ticket.key, 1);
    const blockers = ticket.blocked_by.map((key) => byKey.get(key)).filter(Boolean);
    const value = 1 + Math.max(0, ...blockers.map(longest));
    depth.set(ticket.key, value);
    return value;
  };
  const chain = Math.max(0, ...tickets.map(longest));
  return {
    small: small.map((ticket) => ticket.key),
    ratio,
    mergeCandidates: [...candidates].sort(),
    chain,
    blocking: small.length >= 4 && ratio >= 0.5,
  };
}

function splitSections(body) {
  const preamble = [];
  const list = [];
  let current = null;
  for (const line of String(body || "").split("\n")) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      current = { heading: match[1], lines: [] };
      list.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  return { preamble, sections: list };
}

function sectionText(lines) {
  return lines.join("\n").replace(/^\n+|\n+$/g, "");
}

function campaignBody(previousBody, plan) {
  const { sections } = splitSections(previousBody);
  const extras = sections.filter((section) => !STANDARD_SECTIONS.has(section.heading.toLowerCase()));
  const blocks = [
    `## Goal\n\n${plan.goal}`,
    `## Brief\n\n${plan.brief}`,
    `## Acceptance criteria\n\n${plan.criteria.map((item) => `- [ ] ${item}`).join("\n")}`,
    `## Constraints\n\n${plan.constraints}`,
    `## Assumptions\n\n${
      plan.assumptions.length ? plan.assumptions.map((item) => `- ${item}`).join("\n") : "None."
    }`,
    `## Open questions\n\n${
      plan.open_questions.length ? plan.open_questions.map((item) => `- ${item}`).join("\n") : "None."
    }`,
    `## What to read first\n\n${plan.reading}`,
  ];
  for (const section of extras) blocks.push(`## ${section.heading}\n\n${sectionText(section.lines)}`);
  return `${blocks.join("\n\n")}\n`;
}

function ticketBody(spec) {
  const lines = [
    `# ${spec.title}`,
    "",
    "## What to build",
    "",
    spec.what,
    "",
    "## Acceptance criteria",
    "",
    spec.accept.map((item) => `- [ ] ${item}`).join("\n"),
    "",
  ];
  if (spec.notes) lines.push("## Notes", "", spec.notes, "");
  return lines.join("\n");
}

function snapshot(root, slug) {
  const campaign = readCampaign(root, slug);
  const dir = ticketsDir(root, slug);
  const files = exists(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => ({ file: path.join(dir, f), text: readText(path.join(dir, f), "") }))
    : [];
  return { campaignFile: campaign.file, campaignText: readText(campaign.file, ""), files };
}

function restore(snap) {
  fs.writeFileSync(snap.campaignFile, snap.campaignText);
  const dir = path.dirname(snap.campaignFile);
  const ticketDir = path.join(dir, "tickets");
  if (exists(ticketDir)) {
    for (const name of fs.readdirSync(ticketDir)) {
      if (name.endsWith(".md")) fs.unlinkSync(path.join(ticketDir, name));
    }
  }
  for (const entry of snap.files) fs.writeFileSync(entry.file, entry.text);
}

/* Import a plan atomically. Existing keyed tickets keep their id and file;
   new keys get the next ids. `prune` removes keyed tickets missing from the
   plan, but only when `canRemove(id)` agrees (the caller checks runs). */
export function importPlan({ root, slug, plan, allowedKinds = null, prune = false, canRemove = null, acceptOpen = false, acceptFragmented = false }) {
  const normalized = normalizePlan(plan, { allowedKinds });
  const fragmentation = planFragmentation(normalized);
  if (fragmentation.blocking && !acceptFragmented) {
    throw new UserError("The plan is too fragmented", [
      `${fragmentation.small.length} of ${normalized.tickets.length} tickets have one touched path and one acceptance criterion: ${fragmentation.small.join(", ")}`,
      "Merge small neighbors into verifiable slices, or pass --accept-fragmented if this is deliberate.",
    ]);
  }
  if (normalized.open_questions.length && !acceptOpen) {
    throw new UserError("The plan still has open questions", [
      ...normalized.open_questions.map((question) => `! ${question}`),
      "Answer them in the agent session, or pass --accept-open to import with them recorded.",
    ]);
  }
  const campaign = readCampaign(root, slug);
  const existing = loadTickets(root, slug);
  const byKey = new Map();
  for (const ticket of existing) {
    if (ticket.data.key) byKey.set(String(ticket.data.key), ticket);
  }
  const snap = snapshot(root, slug);
  const usedIds = new Set(existing.map((ticket) => ticket.data.id).filter(Boolean));
  let max = Math.max(0, ...existing.map((ticket) => Number(ticket.number || ticket.data.id || 0)));
  const specs = normalized.tickets.map((spec) => {
    const current = byKey.get(spec.key);
    if (current) return { ...spec, id: current.data.id, current };
    let id = pad2(++max);
    while (usedIds.has(id)) id = pad2(++max);
    usedIds.add(id);
    return { ...spec, id, current: null };
  });
  const keyToId = new Map(specs.map((spec) => [spec.key, spec.id]));
  const idToKey = new Map(specs.map((spec) => [spec.id, spec.key]));
  for (const spec of specs) {
    spec.blockedBy = spec.blocked_by.map((ref) => {
      if (keyToId.has(ref)) return keyToId.get(ref);
      const normalizedRef = slugify(ref);
      if (keyToId.has(normalizedRef)) return keyToId.get(normalizedRef);
      if (/^\d+$/.test(ref)) {
        const id = pad2(ref);
        if (!specs.some((entry) => entry.id === id))
          throw new UserError(`ticket "${spec.title}" is blocked by unknown ticket "${ref}"`);
        return id;
      }
      throw new UserError(`ticket "${spec.title}" is blocked by unknown key "${ref}"`);
    });
  }
  const keep = new Set(specs.map((spec) => spec.key));
  const removed = [];
  if (prune) {
    for (const ticket of existing) {
      const key = ticket.data.key ? String(ticket.data.key) : null;
      if (!key || keep.has(key)) continue;
      if (canRemove && !canRemove(ticket.data.id)) {
        throw new UserError(`Ticket ${ticket.data.id} has runs; refusing to prune it`, [
          "Remove or re-key it in the agent session, or import without --prune.",
        ]);
      }
      removed.push(ticket);
    }
  }

  const created = [];
  const updated = [];
  try {
    const dir = ticketsDir(root, slug);
    ensureDir(dir);
    for (const spec of specs) {
      const target = spec.current?.file || path.join(dir, `${spec.id}-${slugify(spec.title)}.md`);
      const data = { id: spec.id, key: spec.key, kind: spec.kind, touches: spec.touches };
      if (spec.blockedBy.length) data.blocked_by = spec.blockedBy;
      if (spec.attachments.length) data.attachments = spec.attachments;
      if (spec.sources.length) data.sources = spec.sources;
      const content = joinFrontmatter(data, ticketBody(spec));
      const before = spec.current ? readText(target, null) : null;
      if (before !== content) fs.writeFileSync(target, content);
      if (spec.current) {
        if (before !== content) updated.push({ id: spec.id, key: spec.key, title: spec.title, kind: spec.kind, file: target });
      } else {
        created.push({ id: spec.id, key: spec.key, title: spec.title, kind: spec.kind, file: target });
      }
    }
    for (const ticket of removed) fs.unlinkSync(ticket.file);
    const campaignText = joinFrontmatter(campaign.data, campaignBody(campaign.body, normalized));
    if (readText(campaign.file, null) !== campaignText) fs.writeFileSync(campaign.file, campaignText);
    const after = loadPlan(root, slug);
    if (after.errors.length) {
      throw new UserError(`That plan would not validate, so it was not saved: ${after.errors.join("; ")}`, after.errors);
    }
    return {
      slug,
      file: campaign.file,
      context: readContext(root, slug).file,
      tickets: specs.map((spec) => ({
        id: spec.id,
        key: spec.key,
        title: spec.title,
        kind: spec.kind,
        blocked_by: spec.blockedBy,
        file: spec.current?.file || path.join(dir, `${spec.id}-${slugify(spec.title)}.md`),
      })),
      created,
      updated,
      removed: removed.map((ticket) => ({ id: ticket.data.id, key: ticket.data.key })),
      idToKey: Object.fromEntries(idToKey),
      assumptions: normalized.assumptions,
      openQuestions: normalized.open_questions,
      plan: normalized,
      fragmentation,
    };
  } catch (err) {
    restore(snap);
    throw err;
  }
}
