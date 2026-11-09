// Prompts are content: they live in references/ and are filled here.
import path from "node:path";
import { SKILL_DIR, REPORT_SCRIPT, readText } from "./util.mjs";
import { asArray } from "./plan.mjs";

function template(name, values) {
  const text = readText(path.join(SKILL_DIR, "references", name));
  if (text === null) throw new Error(`missing prompt template references/${name}`);
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? "") : match,
  );
}

export function renderCriteria(ticket) {
  if (!ticket.criteria.length) return "(none declared)";
  return ticket.criteria.map((c) => `- [ ] ${c.text}`).join("\n");
}

export function renderReading(sections) {
  const reading = (sections["what to read first"] || "").trim();
  return reading || "Nothing declared. Explore the repository yourself.";
}

export function renderDecisions(decisions) {
  if (!decisions.length) return "None recorded.";
  return decisions.map((d) => `- ${d.text}${d.cite ? ` (${d.cite})` : ""}`).join("\n");
}

const QUESTION_RULE = [
  "Ask only when the answer is not in the campaign form, the ticket, the standing decisions, or the repository.",
  "If you ask, that is the end of this turn: report `needs_answer` and stop. Do not guess and continue.",
].join(" ");

export function workerPrompt({ campaign, ticket, ticketTitle, runId, workdir, base, kind, decisions, sections, data }) {
  return template("worker-prompt.md", {
    CAMPAIGN: campaign,
    TICKET_ID: ticket,
    TICKET_TITLE: ticketTitle,
    KIND: kind,
    RUN_ID: runId,
    WORKDIR: workdir,
    BASE: base,
    TICKET_BODY: data.what,
    ACCEPTANCE: renderCriteria(data),
    READING: renderReading(sections),
    BRIEF: (sections.brief || "(none)").trim(),
    CONSTRAINTS: (sections.constraints || "(none)").trim(),
    DECISIONS: renderDecisions(decisions),
    QUESTION_RULE,
    CONTEXT_CMD: `node ${path.join(SKILL_DIR, "scripts", "orchestrate.mjs")} context`,
    REPORT_CMD: `node ${REPORT_SCRIPT}`,
  });
}

export function reviewPrompt({ campaign, ticket, ticketTitle, runId, workdir, base, kind, data, landing }) {
  const diffInstructions =
    landing === "directory"
      ? [
          "There is no branch here: this campaign lands files in place. Read the files the ticket declares, in full:",
          "",
          asArray(data.data?.touches ?? data.touches).map((path) => `  ${path}`).join("\n") ||
            "  (the ticket declares no paths; read what it names)",
        ].join("\n")
      : ["```", `git diff ${base}...HEAD`, `git log --oneline ${base}..HEAD`, "```"].join("\n");
  return template("review-prompt.md", {
    CAMPAIGN: campaign,
    TICKET_ID: ticket,
    TICKET_TITLE: ticketTitle,
    KIND: kind,
    RUN_ID: runId,
    WORKDIR: workdir,
    BASE: base,
    TICKET_BODY: data.what,
    ACCEPTANCE: renderCriteria(data),
    REPORT_CMD: `node ${REPORT_SCRIPT}`,
  });
}

export function judgePrompt({ campaign, ticket, ticketTitle, question, summary, sections, data, decisions }) {
  return template("judge-prompt.md", {
    CAMPAIGN: campaign,
    TICKET_ID: ticket,
    TICKET_TITLE: ticketTitle,
    QUESTION: question?.text || "(no question text)",
    SUMMARY: summary || "(none)",
    GOAL: (sections.goal || "(none)").trim(),
    BRIEF: (sections.brief || "(none)").trim(),
    CAMPAIGN_ACCEPTANCE: (sections["acceptance criteria"] || "(none)").trim(),
    CONSTRAINTS: (sections.constraints || "(none)").trim(),
    DECISIONS: renderDecisions(decisions),
    TICKET_BODY: data.what,
    ACCEPTANCE: renderCriteria(data),
    REPORT_CMD: `node ${REPORT_SCRIPT}`,
  });
}

export function resumePrompt({ ticket, answer, citation, findings }) {
  const lines = [];
  if (findings) {
    const detail = String(findings).trim();
    lines.push("Your work was reviewed and sent back. Blocking findings:", "");
    lines.push(detail && detail !== "check \"tests\" failed:" ? detail : "The gate failed and recorded no detail.");
    lines.push("", "Run the campaign's checks yourself now, fix everything they report, then report again.");
  } else {
    lines.push("Answer to your question:", "", answer, "");
    if (citation) lines.push(`Source: ${citation}`, "");
    lines.push("Continue the ticket. Do not ask the same question again.");
  }
  lines.push("", `Ticket: ${ticket}. Report when the acceptance criteria hold, or when you are genuinely stuck.`);
  return lines.join("\n");
}

export function mergePrompt({ root, slug, ticket, conflict }) {
  return [
    `You are resolving a merge conflict for tickets of campaign ${slug}.`,
    "",
    `Worktree: ${root}`,
    `Ticket branch: orch/${slug}/${ticket}`,
    "",
    "The integration branch could not merge the ticket branch. The conflict was:",
    "",
    "```",
    conflict.trim() || "(no output captured)",
    "```",
    "",
    "Resolve it so both the integration branch's work and the ticket's work survive:",
    "",
    "1. In this worktree, merge the ticket branch into the integration branch.",
    "2. Resolve each conflict by reading both sides, never by discarding one.",
    "3. Run the campaign's checks.",
    "4. Commit the merge.",
    "",
    `Report ready with the merged commit, or failed with what makes the conflict unresolvable.`,
  ].join("\n");
}

export function blockersLine(ticket) {
  const blockers = asArray(ticket.data.blocked_by);
  return blockers.length ? blockers.join(", ") : "none";
}
