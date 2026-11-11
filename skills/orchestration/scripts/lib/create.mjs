// Creating campaigns and tickets, from the CLI or the panel. One source of truth.
import fs from "node:fs";
import path from "node:path";
import { UserError, campaignPlanDir, ensureDir, exists, git, isGitRepo, pad2, readText } from "./util.mjs";
import { loadConsole, readCampaign, resolveKinds } from "./config.mjs";
import { asArray, loadPlan, ticketsDir, ticketTitle } from "./plan.mjs";
import { joinFrontmatter } from "./yaml.mjs";
import { normalizeCovers } from "./evidence.mjs";

export function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "campaign"
  );
}

export function defaultBase(root) {
  if (!isGitRepo(root)) return "main";
  return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "main";
}

export function ensureGitignore(root) {
  if (!isGitRepo(root)) return false;
  const file = path.join(root, ".gitignore");
  const current = exists(file) ? readText(file, "") : "";
  const lines = current.split("\n").map((line) => line.trim());
  if (lines.includes(".orchestration/") || lines.includes(".orchestration")) return false;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(file, `${current}${prefix}.orchestration/\n`);
  return true;
}

export function createCampaign({ root, goal, slug, autonomy, planGate, landing, base }) {
  const text = String(goal || "").trim();
  if (!text) throw new UserError("A campaign needs a goal: one sentence about the outcome");
  const name = String(slug || "").trim() || slugify(text);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new UserError(`"${name}" is not a campaign name`, ["Use lowercase letters, digits and hyphens."]);
  if (!exists(campaignPlanDir(root, "x"))) ensureDir(path.join(root, "orchestration"));
  const dir = campaignPlanDir(root, name);
  const file = path.join(dir, "campaign.md");
  if (exists(file)) throw new UserError(`Campaign "${name}" already exists`, [file]);
  ensureDir(path.join(dir, "tickets"));
  const data = {
    campaign: name,
    stage: "draft",
    autonomy: autonomy || "supervised",
    plan_gate: planGate || "human",
    landing: landing || (isGitRepo(root) ? "branch" : "directory"),
    base: base || defaultBase(root),
    checks: [],
    budget: { tokens: null, dollars: null },
    max_autoship_lines: 200,
    kinds: {},
  };
  const body = [
    "## Goal",
    "",
    text,
    "",
    "## Brief",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] ",
    "",
    "## Constraints",
    "",
    "## What to read first",
    "",
    "- **Files:** ",
    "- **Material:** ",
    "- **Links:** ",
    "",
  ].join("\n");
  fs.writeFileSync(file, joinFrontmatter(data, body));
  return { slug: name, file };
}

export function nextTicketId(root, slug) {
  const dir = ticketsDir(root, slug);
  if (!exists(dir)) return "01";
  const ids = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => Number((f.match(/^(\d+)/) || [])[1] || 0));
  return pad2(Math.max(0, ...ids) + 1);
}

function criteriaBlock(criteria) {
  return criteria.map((c) => `- [ ] ${c}`).join("\n");
}

function writeTicketFile(file, data, body) {
  fs.writeFileSync(file, joinFrontmatter(data, body));
}

function campaignCriteria(root, slug) {
  const campaign = readCampaign(root, slug);
  return String(campaign.sections["acceptance criteria"] || "")
    .split("\n")
    .map((line) => line.match(/^\s*-\s*\[( |x|X)\]\s*(.+)$/))
    .filter(Boolean)
    .map((match) => match[2].trim());
}

function checkedCovers(root, slug, value, label = "ticket") {
  if (value === undefined) return null;
  const checked = normalizeCovers(value, campaignCriteria(root, slug), label);
  if (checked.errors.length) {
    throw new UserError(`Invalid coverage claim`, [
      ...checked.errors,
      "Every `covers` entry must exactly match a campaign criterion after whitespace normalization.",
    ]);
  }
  return checked.covers;
}

function ticketBody({ title, what, criteria }) {
  return [
    `# ${title}`,
    "",
    "## What to build",
    "",
    String(what || "").trim() || title,
    "",
    "## Acceptance criteria",
    "",
    criteriaBlock(criteria),
    "",
  ].join("\n");
}

export function editTicket({ root, slug, id, patch = {} }) {
  const plan = loadPlan(root, slug);
  const ticket = plan.byId.get(pad2(id));
  if (!ticket) throw new UserError(`No ticket "${id}" in ${slug}`);
  const previous = fs.readFileSync(ticket.file, "utf8");
  const data = { ...ticket.data };
  if (patch.title) data.title = undefined;
  if (patch.kind) {
    const kinds = resolveKinds(loadConsole(), readCampaign(root, slug).data);
    if (!kinds[patch.kind]) throw new UserError(`Unknown ticket kind "${patch.kind}"`, [`one of ${Object.keys(kinds).join(", ")}`]);
    data.kind = patch.kind;
  }
  if (patch.touches !== undefined) {
    const paths = (Array.isArray(patch.touches) ? patch.touches : String(patch.touches).split(",")).map((t) => String(t).trim()).filter(Boolean);
    if (!paths.length) throw new UserError("A ticket needs at least one touched path");
    data.touches = paths;
  }
  if (patch.blocked_by !== undefined) {
    const blockers = (Array.isArray(patch.blocked_by) ? patch.blocked_by : String(patch.blocked_by).split(","))
      .map((b) => String(b).trim())
      .filter(Boolean)
      .map(pad2);
    if (blockers.length) data.blocked_by = blockers;
    else delete data.blocked_by;
  }
  if (patch.attachments !== undefined) {
    const images = (Array.isArray(patch.attachments) ? patch.attachments : String(patch.attachments).split(","))
      .map((a) => String(a).trim())
      .filter(Boolean);
    if (images.length) data.attachments = images;
    else delete data.attachments;
  }
  if (patch.covers !== undefined) {
    const covers = checkedCovers(root, slug, patch.covers);
    if (covers.length) data.covers = covers;
    else delete data.covers;
  }
  delete data.title;
  const title = String(patch.title || ticketTitle(ticket)).trim();
  const what = patch.what !== undefined ? patch.what : ticket.what;
  const criteria = patch.criteria !== undefined
    ? (Array.isArray(patch.criteria) ? patch.criteria : String(patch.criteria).split("\n")).map((c) => String(c).trim()).filter(Boolean)
    : ticket.criteria.map((c) => c.text);
  if (!criteria.length) throw new UserError("A ticket needs at least one acceptance criterion");
  writeTicketFile(ticket.file, data, ticketBody({ title, what, criteria }));
  const after = loadPlan(root, slug);
  if (after.errors.length) {
    fs.writeFileSync(ticket.file, previous);
    throw new UserError(`That edit would break the plan, so it was not saved: ${after.errors.join("; ")}`, after.errors);
  }
  return { id: data.id, file: ticket.file };
}

export function removeTicket({ root, slug, id }) {
  const plan = loadPlan(root, slug);
  const ticket = plan.byId.get(pad2(id));
  if (!ticket) throw new UserError(`No ticket "${id}" in ${slug}`);
  const dependents = plan.ordered.filter((entry) =>
    asArray(entry.data.blocked_by).map(pad2).includes(ticket.data.id),
  );
  if (dependents.length) {
    throw new UserError(`Ticket ${ticket.data.id} still blocks ${dependents.map((d) => d.data.id).join(", ")}`, [
      "Re-point or remove those tickets first.",
    ]);
  }
  fs.unlinkSync(ticket.file);
  return { id: ticket.data.id, file: ticket.file };
}

export function addTicket({
  root,
  slug,
  title,
  kind,
  blockedBy = [],
  touches = [],
  attachments = [],
  what,
  criteria = [],
  covers = [],
}) {
  const campaign = readCampaign(root, slug);
  const name = String(title || "").trim();
  if (!name) throw new UserError("A ticket needs a title");
  const kinds = resolveKinds(loadConsole(), campaign.data);
  if (!kind) throw new UserError("A ticket needs a kind", [`one of ${Object.keys(kinds).join(", ")}`]);
  if (!kinds[kind]) throw new UserError(`Unknown ticket kind "${kind}"`, [`one of ${Object.keys(kinds).join(", ")}`]);
  const paths = (Array.isArray(touches) ? touches : String(touches).split(",")).map((t) => String(t).trim()).filter(Boolean);
  if (!paths.length) throw new UserError("Say which paths this ticket may touch", ['For example "src/api/**".']);
  const acceptance = (Array.isArray(criteria) ? criteria : String(criteria).split("\n")).map((c) => String(c).trim()).filter(Boolean);
  if (!acceptance.length) throw new UserError("A ticket needs at least one acceptance criterion");
  const blockers = (Array.isArray(blockedBy) ? blockedBy : String(blockedBy).split(","))
    .map((b) => String(b).trim())
    .filter(Boolean)
    .map(pad2);
  const images = (Array.isArray(attachments) ? attachments : String(attachments).split(","))
    .map((a) => String(a).trim())
    .filter(Boolean);
  const claimed = checkedCovers(root, slug, covers, `ticket "${name}"`);

  const id = nextTicketId(root, slug);
  const dir = ticketsDir(root, slug);
  ensureDir(dir);
  const file = path.join(dir, `${id}-${slugify(name)}.md`);
  const data = { id, kind, touches: paths };
  if (blockers.length) data.blocked_by = blockers;
  if (images.length) data.attachments = images;
  if (claimed.length) data.covers = claimed;
  const body = [
    `# ${name}`,
    "",
    "## What to build",
    "",
    String(what || "").trim() || name,
    "",
    "## Acceptance criteria",
    "",
    criteriaBlock(acceptance),
    "",
  ].join("\n");
  fs.writeFileSync(file, joinFrontmatter(data, body));

  const plan = loadPlan(root, slug);
  if (plan.errors.length) {
    fs.unlinkSync(file);
    throw new UserError(
      `Ticket "${name}" would break the plan, so it was not written: ${plan.errors.join("; ")}`,
      plan.errors,
    );
  }
  return { id, file, title: name, kind, blocked_by: blockers, touches: paths };
}
