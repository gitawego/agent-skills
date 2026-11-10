// Tickets: parse, validate, and order the graph.
import fs from "node:fs";
import path from "node:path";
import { UserError, exists, pad2, readText } from "./util.mjs";
import { splitFrontmatter } from "./yaml.mjs";
import { sections } from "./config.mjs";

const TICKET_FIELDS = new Set(["id", "kind", "blocked_by", "touches", "attachments"]);

export function ticketsDir(root, slug) {
  return path.join(root, "orchestration", slug, "tickets");
}

export function parseTicket(text, file = "ticket.md") {
  const { data, body } = splitFrontmatter(text);
  const parsed = sections(body);
  const criteriaText = parsed["acceptance criteria"] || "";
  const criteria = criteriaText
    .split("\n")
    .map((line) => line.match(/^\s*-\s*\[( |x|X)\]\s*(.+)$/))
    .filter(Boolean)
    .map((m) => ({ done: m[1].toLowerCase() === "x", text: m[2].trim() }));
  return {
    file,
    data: { ...data, id: data.id != null ? pad2(data.id) : null },
    body,
    sections: parsed,
    what: (parsed["what to build"] || "").trim(),
    notes: (parsed["notes"] || "").trim(),
    criteria,
    criteriaText,
  };
}

export function loadTickets(root, slug) {
  const dir = ticketsDir(root, slug);
  if (!exists(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  return files.map((f) => {
    const file = path.join(dir, f);
    const ticket = parseTicket(readText(file, ""), file);
    ticket.slug = f.replace(/\.md$/, "");
    ticket.number = (f.match(/^(\d+)/) || [])[1] || null;
    return ticket;
  });
}

export function ticketTitle(ticket) {
  const heading = (ticket.body.match(/^#\s+(.+)$/m) || [])[1];
  if (heading) return heading.trim();
  return ticket.slug.replace(/^\d+-/, "").replace(/-/g, " ");
}

export function asArray(value) {
  if (value == null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

export function validateTickets(tickets) {
  const errors = [];
  const byId = new Map();
  for (const ticket of tickets) {
    const id = ticket.data.id;
    if (!id) {
      errors.push(`${path.basename(ticket.file)}: no id in frontmatter`);
      continue;
    }
    if (!/^\d+$/.test(id)) errors.push(`${path.basename(ticket.file)}: id "${id}" must be a number`);
    if (ticket.number && pad2(ticket.number) !== id)
      errors.push(`${path.basename(ticket.file)}: id "${id}" does not match the file number "${ticket.number}"`);
    if (byId.has(id)) errors.push(`duplicate ticket id "${id}"`);
    byId.set(id, ticket);

    for (const key of Object.keys(ticket.data)) {
      if (!TICKET_FIELDS.has(key)) errors.push(`${id}: unknown ticket field "${key}"`);
    }
    if (!ticket.data.kind) errors.push(`${id}: no kind`);
    if (!ticket.what) errors.push(`${id}: "What to build" is empty`);
    if (!ticket.criteria.length) errors.push(`${id}: no acceptance criteria`);
    const touches = asArray(ticket.data.touches);
    if (!touches.length) errors.push(`${id}: no touches; declare the paths this ticket may modify`);
    for (const attachment of asArray(ticket.data.attachments)) {
      const file = String(attachment);
      if (path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
        errors.push(`${id}: attachment "${file}" must be a path inside the project`);
      else if (!/\.(png|jpe?g|webp|gif)$/i.test(file))
        errors.push(`${id}: attachment "${file}" is not a supported image`);
    }
  }

  for (const ticket of tickets) {
    const id = ticket.data.id;
    if (!id) continue;
    for (const blocker of asArray(ticket.data.blocked_by).map(pad2)) {
      if (blocker === id) errors.push(`${id}: blocks itself`);
      else if (!byId.has(blocker)) errors.push(`${id}: blocked by unknown ticket "${blocker}"`);
    }
  }

  const state = new Map();
  const visit = (id, trail = []) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") {
      errors.push(`blocking cycle: ${[...trail, id].join(" -> ")}`);
      return;
    }
    state.set(id, "open");
    const ticket = byId.get(id);
    for (const blocker of asArray(ticket?.data.blocked_by).map(pad2)) {
      if (byId.has(blocker) && blocker !== id) visit(blocker, [...trail, id]);
    }
    state.set(id, "done");
  };
  for (const id of byId.keys()) visit(id);

  const ordered = [...byId.values()].sort((a, b) =>
    String(a.data.id).padStart(4, "0").localeCompare(String(b.data.id).padStart(4, "0")),
  );

  return { errors, byId, ordered };
}

export function loadPlan(root, slug) {
  const tickets = loadTickets(root, slug);
  const { errors, byId, ordered } = validateTickets(tickets);
  if (!tickets.length) errors.push("the campaign has no tickets");
  return { tickets, byId, ordered, errors };
}

export function requirePlan(root, slug) {
  const plan = loadPlan(root, slug);
  if (plan.errors.length) {
    throw new UserError(`The plan for "${slug}" is invalid`, plan.errors);
  }
  return plan;
}

// --- globs -----------------------------------------------------------------

function globToRegex(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

export function matchTouches(globs, file) {
  const normalized = String(file).replace(/^\.\//, "");
  return asArray(globs).some((glob) => {
    const g = String(glob).replace(/^\.\//, "").replace(/\/$/, "");
    if (globToRegex(g).test(normalized)) return true;
    if (normalized === g) return true;
    if (normalized.startsWith(`${g}/`)) return true;
    if (g.endsWith("/**") && normalized.startsWith(g.slice(0, -3))) return true;
    return false;
  });
}

export function touchesOverlap(a, b) {
  const listA = asArray(a);
  const listB = asArray(b);
  for (const ga of listA) {
    const prefixA = String(ga).replace(/\/\*\*$/, "").replace(/\/$/, "");
    for (const gb of listB) {
      const prefixB = String(gb).replace(/\/\*\*$/, "").replace(/\/$/, "");
      if (matchTouches([ga], prefixB) || matchTouches([gb], prefixA)) return true;
      if (matchTouches([ga], `${prefixB}/x`) || matchTouches([gb], `${prefixA}/x`)) return true;
    }
  }
  return false;
}
