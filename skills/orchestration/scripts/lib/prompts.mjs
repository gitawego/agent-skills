// Prompts are content: they live in references/ and are filled here.
import crypto from "node:crypto";
import path from "node:path";
import { SKILL_DIR, REPORT_SCRIPT, clip, exists, readText } from "./util.mjs";
import { asArray } from "./plan.mjs";
import { renderFindings } from "./evidence.mjs";

const CONTRACT_FILE = path.join(SKILL_DIR, "references", "contract.md");
const ROLES_DIR = path.join(SKILL_DIR, "references", "roles");

/* The system prompt is pi's default plus two files: the standing contract and
   the role contract for this run. A custom ticket kind gets the general role. */
export function systemPromptFiles(role) {
  if (!exists(CONTRACT_FILE)) throw new Error(`missing prompt file ${CONTRACT_FILE}`);
  const named = path.join(ROLES_DIR, `${role}.md`);
  const roleFile = exists(named) ? named : path.join(ROLES_DIR, "general.md");
  if (!exists(roleFile)) throw new Error(`missing prompt file ${roleFile}`);
  return [CONTRACT_FILE, roleFile];
}

export function promptDigest(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/* Context cost travels with the run, so a later prompt-size regression is
   visible instead of being guessed from the log. */
export function promptAudit(prompt, { dependencies = [], decisions = [] } = {}) {
  const text = String(prompt || "");
  const dependencyText = JSON.stringify(asArray(dependencies));
  const decisionText = JSON.stringify(asArray(decisions));
  return {
    promptChars: text.length,
    promptTokensEstimate: Math.ceil(text.length / 4),
    dependencyChars: dependencyText.length,
    dependencyCount: asArray(dependencies).length,
    decisionChars: decisionText.length,
    decisionCount: asArray(decisions).length,
  };
}

/* The system prompt is files, not one string; hash the resolved contents so a
   run stays explainable after the contract or a role file changes. */
export function systemPromptDigest(files) {
  const text = files.map((file) => readText(file, "")).join("\n\0\n");
  return crypto.createHash("sha256").update(text).digest("hex");
}

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

export const PROMPT_LIMITS = {
  briefChars: 5_000,
  constraintsChars: 3_000,
  readingChars: 2_000,
  decisions: 12,
  decisionChars: 500,
  dependencies: 8,
  dependencyChars: 1_400,
  dependencySummaryChars: 600,
  acceptanceEvidenceChars: 400,
  ticketBodyChars: 8_000,
};

export function renderReading(sections) {
  const reading = clip((sections["what to read first"] || "").trim(), PROMPT_LIMITS.readingChars, "reading list truncated");
  return reading || "Nothing declared. Explore the repository yourself.";
}

export function renderDecisions(decisions) {
  const list = asArray(decisions);
  if (!list.length) return "None recorded.";
  const shown = list.slice(-PROMPT_LIMITS.decisions);
  const lines = shown.map(
    (d) => `- ${clip(d.text, PROMPT_LIMITS.decisionChars, "decision truncated")}${d.cite ? ` (${d.cite})` : ""}`,
  );
  if (list.length > shown.length) {
    lines.push(`- … ${list.length - shown.length} older decision${list.length - shown.length === 1 ? "" : "s"} omitted; run \`orchestrate decisions\` for the rest.`);
  }
  return lines.join("\n");
}

export function renderAttachments(paths) {
  if (!paths.length) return "None attached.";
  return paths.map((file) => `- \`${file}\` (attached to this turn)`).join("\n");
}

/* Blocker context is evidence, not a second brief: it tells a dependent worker
   what already landed and what evidence proved it, without letting the
   dependency widen this ticket's scope. */
export function renderDependencies(dependencies) {
  const list = asArray(dependencies).filter((dependency) => dependency && dependency.id);
  if (!list.length) return "No completed blockers. Start from the campaign brief and the repository.";
  const shown = list.slice(0, PROMPT_LIMITS.dependencies);
  const blocks = shown.map((dependency) => {
    const lines = [
      `- **${dependency.id} ${dependency.title || dependency.id}** — ${clip(
        dependency.summary || "completed",
        PROMPT_LIMITS.dependencySummaryChars,
        "summary truncated",
      )}`,
    ];
    const touched = asArray(dependency.touched).filter(Boolean);
    lines.push(`  files: ${touched.length ? touched.map((file) => clip(file, 300, "path truncated")).join(", ") : "not reported"}`);
    const checks = asArray(dependency.checks).filter((check) => check && check.name);
    if (checks.length) {
      lines.push(`  checks already run (worker report): ${checks.map((check) => `${check.name} (${check.ok === false ? "fail" : "pass"})`).join(", ")}`);
    }
    if (dependency.next) lines.push(`  handoff: ${clip(dependency.next, 500, "handoff truncated")}`);
    const acceptance = asArray(dependency.acceptance).filter((result) => result && result.criterion);
    if (acceptance.length) {
      lines.push(
        `  acceptance: ${acceptance
          .map(
            (result) =>
              `${clip(result.criterion, 300, "criterion truncated")} (${result.status || "reported"}${
                result.evidence ? `: ${clip(result.evidence, PROMPT_LIMITS.acceptanceEvidenceChars, "evidence truncated")}` : ""
              })`,
          )
          .join("; ")}`,
      );
    }
    return clip(lines.join("\n"), PROMPT_LIMITS.dependencyChars, "dependency context truncated");
  });
  if (list.length > shown.length) {
    blocks.push(`- … ${list.length - shown.length} more completed blocker${list.length - shown.length === 1 ? "" : "s"} omitted; run \`orchestrate context --ticket <id> --packet\` for the rest.`);
  }
  return blocks.join("\n");
}

const QUESTION_RULE = [
  "Ask only when the answer is not in the campaign form, the ticket, the standing decisions, or the repository.",
  "If you ask, that is the end of this turn: report `needs_answer` and stop. Do not guess and continue.",
].join(" ");

const ACCEPTANCE_RULE = [
  "A `ready` report must carry one result for every acceptance criterion below.",
  "Write a JSON array to the system temp directory and pass it with `--acceptance-file`:",
  '  [{"criterion":"<exact criterion text>","status":"passed","evidence":"the command or observation that proves it"}]',
  "Every result must be `passed`. If one is `failed`, report `failed` instead; the supervisor reruns the checks and will not treat a partial pass as done.",
].join("\n");

export function workerPrompt({
  campaign,
  ticket,
  ticketTitle,
  runId,
  workdir,
  base,
  kind,
  decisions,
  sections,
  data,
  attachments = [],
  dependencies = [],
}) {
  return template("worker-prompt.md", {
    CAMPAIGN: campaign,
    TICKET_ID: ticket,
    TICKET_TITLE: ticketTitle,
    KIND: kind,
    RUN_ID: runId,
    WORKDIR: workdir,
    BASE: base,
    TICKET_BODY: clip(data.what, PROMPT_LIMITS.ticketBodyChars, "ticket body truncated"),
    ACCEPTANCE: renderCriteria(data),
    ATTACHMENTS: renderAttachments(attachments),
    READING: renderReading(sections),
    BRIEF: clip((sections.brief || "(none)").trim(), PROMPT_LIMITS.briefChars, "brief truncated"),
    CONSTRAINTS: clip((sections.constraints || "(none)").trim(), PROMPT_LIMITS.constraintsChars, "constraints truncated"),
    DECISIONS: renderDecisions(decisions),
    DEPENDENCIES: renderDependencies(dependencies),
    QUESTION_RULE,
    ACCEPTANCE_RULE,
    CONTEXT_CMD: `node ${path.join(SKILL_DIR, "scripts", "orchestrate.mjs")} context`,
    REPORT_CMD: `node ${REPORT_SCRIPT}`,
  });
}

const FINDINGS_RULE = [
  "Report findings as a JSON array with `--findings-file`; do not bury them in prose:",
  '  [{"id":"F1","severity":"blocker","file":"src/cli.ts","line":42,"problem":"argv is sliced twice","requiredFix":"slice once and add a regression test"}]',
  "Severity is `low`, `medium`, `high`, or `blocker`.",
  "`ready` may carry low/medium findings; any high or blocker finding means `failed`.",
  "A `failed` review needs at least one high or blocker finding. A failure with only low/medium findings is a `ready` with warnings.",
].join("\n");

export function reviewPrompt({ campaign, ticket, ticketTitle, runId, workdir, base, kind, data, landing, attachments = [], reviewedHead = null }) {
  const diffInstructions =
    landing === "directory"
      ? [
          "There is no branch here: this campaign lands files in place. Read the files the ticket declares, in full:",
          "",
          asArray(data.data?.touches ?? data.touches).map((path) => `  ${path}`).join("\n") ||
            "  (the ticket declares no paths; read what it names)",
        ].join("\n")
      : ["```", `git diff --stat ${base}...HEAD`, `git diff ${base}...HEAD`, `git log --oneline ${base}..HEAD`, "```"].join("\n");
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
    ATTACHMENTS: renderAttachments(attachments),
    DIFF: diffInstructions,
    FINDINGS_RULE,
    REVIEWED_HEAD: reviewedHead || "(no commit: directory landing)",
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

export function resumePrompt({ ticket, answer, citation, findings, attachments = [] }) {
  const lines = [];
  if (findings) {
    const detail = Array.isArray(findings) ? renderFindings(findings) : String(findings).trim();
    lines.push("Your work was reviewed and sent back. Blocking findings:", "");
    lines.push(detail && detail !== "check \"tests\" failed:" ? detail : "The gate failed and recorded no detail.");
    lines.push("", "Run the campaign's checks yourself now, fix everything they report, then report again.");
  } else {
    lines.push("Answer to your question:", "", answer, "");
    if (citation) lines.push(`Source: ${citation}`, "");
    lines.push("Continue the ticket. Do not ask the same question again.");
  }
  lines.push("", `Ticket: ${ticket}. Report when the acceptance criteria hold, or when you are genuinely stuck.`);
  if (attachments.length) lines.push("", "Attached images:", ...attachments.map((file) => `- ${file}`));
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
