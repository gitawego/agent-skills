// Evidence is a domain concept: criteria, claims, findings and coverage.
//
// This module is pure. It never reads a campaign, a run, or the filesystem;
// callers pass the data they already loaded. The supervisor and the view both
// use these rules so a report, a ticket drawer and CLOSE cannot disagree.
const SEVERITIES = ["low", "medium", "high", "blocker"];
const BLOCKING = new Set(["high", "blocker"]);

function list(value) {
  if (value == null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function text(value) {
  return String(value ?? "").trim();
}

/* Criteria are compared by meaning-preserving whitespace only. Case and
   punctuation are significant: "Add works" and "add works" are different. */
export function canonicalCriterion(value) {
  return text(value).replace(/\s+/g, " ");
}

/* Acceptance results are matched by the ticket's exact text after trimming.
   Internal whitespace is not collapsed here; the ticket owns that spelling. */
export function matchCriterion(value) {
  return text(value);
}

export function normalizeCriteria(criteria) {
  const seen = new Map();
  const duplicates = [];
  const normalized = [];
  for (const raw of list(criteria)) {
    const criterion = canonicalCriterion(raw);
    if (!criterion) continue;
    if (seen.has(criterion)) {
      if (!duplicates.includes(criterion)) duplicates.push(criterion);
      continue;
    }
    seen.set(criterion, true);
    normalized.push(criterion);
  }
  return { criteria: normalized, duplicates };
}

export function normalizeCovers(covers, criteria, ticketLabel = "ticket") {
  const known = new Map(normalizeCriteria(criteria).criteria.map((item) => [item, true]));
  const errors = [];
  const normalized = [];
  const seen = new Set();
  for (const raw of list(covers)) {
    const criterion = canonicalCriterion(raw);
    if (!criterion || seen.has(criterion)) continue;
    if (!known.has(criterion)) {
      errors.push(`${ticketLabel} covers an unknown campaign criterion "${criterion}"`);
      continue;
    }
    seen.add(criterion);
    normalized.push(criterion);
  }
  return { covers: normalized, errors };
}

export function coverageOf({ criteria = [], tickets = [] } = {}) {
  const normalized = normalizeCriteria(criteria).criteria;
  const rows = normalized.map((criterion) => ({
    criterion,
    tickets: tickets
      .filter((ticket) => normalizeCovers(ticket.covers || [], normalized).covers.includes(criterion))
      .map((ticket) => String(ticket.key || ticket.id || "")),
  }));
  const missing = rows.filter((row) => !row.tickets.length).map((row) => row.criterion);
  return {
    total: rows.length,
    claimed: rows.length - missing.length,
    missing,
    matrix: rows,
    text: formatCoverage({ total: rows.length, claimed: rows.length - missing.length, missing }),
  };
}

export function formatCoverage(coverage) {
  const total = Number(coverage?.total || 0);
  const claimed = Number(coverage?.claimed || 0);
  const missing = coverage?.missing || [];
  const suffix = missing.length ? `; missing: ${missing.join("; ")}` : "";
  return `coverage: ${claimed}/${total} criteria claimed${suffix}`;
}

export function planCoverageWarning(coverage) {
  if (!coverage?.missing?.length) return null;
  return {
    level: "warn",
    code: "coverage",
    text: `${formatCoverage(coverage)}. Coverage is a warning, not a gate; a criterion may be a global constraint.`,
  };
}

/* Shape validation is shared by report.mjs (which cannot know the ticket) and
   the supervisor (which does). Unknown criteria are the supervisor's check. */
export function normalizeAcceptance(acceptance) {
  if (acceptance == null) return { results: [], errors: [] };
  if (!Array.isArray(acceptance)) {
    return { results: [], errors: ["acceptance must be an array of {criterion, status, evidence?} results"] };
  }
  const errors = [];
  const results = [];
  const seen = new Set();
  for (const [index, raw] of acceptance.entries()) {
    const label = `acceptance[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const criterion = matchCriterion(raw.criterion);
    if (!criterion) {
      errors.push(`${label} has no criterion`);
      continue;
    }
    if (seen.has(criterion)) {
      errors.push(`duplicate acceptance result for "${criterion}"`);
      continue;
    }
    seen.add(criterion);
    if (raw.status !== "passed" && raw.status !== "failed") {
      errors.push(`${label} status must be "passed" or "failed"`);
      continue;
    }
    if (raw.evidence != null && typeof raw.evidence !== "string") {
      errors.push(`${label} evidence must be a string when present`);
      continue;
    }
    results.push({
      criterion,
      status: raw.status,
      ...(raw.evidence != null ? { evidence: text(raw.evidence) } : {}),
    });
  }
  return { results, errors };
}

/* A ready claim needs one passed result for every ticket criterion. A failed
   report may be partial: the failure itself is the evidence. */
export function validateAcceptance({ criteria = [], acceptance = null, allowPartial = false } = {}) {
  const expected = list(criteria).map(matchCriterion).filter(Boolean);
  if (acceptance == null) {
    const errors =
      expected.length && !allowPartial
        ? ["acceptance is required for a ready report; record one result for every acceptance criterion"]
        : [];
    return { ok: errors.length === 0, errors, results: [], expected };
  }
  const normalized = normalizeAcceptance(acceptance);
  const errors = [...normalized.errors];
  const known = new Map(expected.map((criterion) => [criterion, true]));
  const results = [];
  for (const result of normalized.results) {
    if (!known.has(result.criterion)) {
      errors.push(`acceptance names an unknown criterion "${result.criterion}"`);
      continue;
    }
    results.push(result);
  }
  if (!allowPartial) {
    const seen = new Set(results.map((item) => item.criterion));
    for (const criterion of expected) {
      if (!seen.has(criterion)) errors.push(`missing acceptance result for "${criterion}"`);
    }
    const failed = results.filter((item) => item.status === "failed");
    if (failed.length) {
      errors.push(
        `ready requires every acceptance result to be passed; failed: ${failed.map((item) => item.criterion).join(", ")}`,
      );
    }
  }
  return { ok: errors.length === 0, errors, results, expected };
}

export function normalizeFindings(findings) {
  if (findings == null) return { findings: [], errors: [] };
  if (!Array.isArray(findings)) {
    return { findings: [], errors: ["findings must be an array of {id, severity, problem, requiredFix}"] };
  }
  const errors = [];
  const normalized = [];
  const ids = new Set();
  for (const [index, raw] of findings.entries()) {
    const label = `findings[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const id = text(raw.id);
    const severity = text(raw.severity);
    const problem = text(raw.problem);
    const requiredFix = text(raw.requiredFix);
    if (!id) errors.push(`${label} id is required`);
    else if (ids.has(id)) errors.push(`duplicate finding id "${id}"`);
    else ids.add(id);
    if (!SEVERITIES.includes(severity)) {
      errors.push(`${label} severity must be one of ${SEVERITIES.join(", ")}`);
    }
    if (!problem) errors.push(`${label} problem is required`);
    if (!requiredFix) errors.push(`${label} requiredFix is required`);
    if (raw.file != null && typeof raw.file !== "string") errors.push(`${label} file must be a string when present`);
    if (raw.line != null && (!Number.isInteger(raw.line) || raw.line < 1)) {
      errors.push(`${label} line must be a positive integer when present`);
    }
    if (errors.some((error) => error.startsWith(label))) continue;
    normalized.push({
      id,
      severity,
      problem,
      requiredFix,
      ...(raw.file != null ? { file: text(raw.file) } : {}),
      ...(raw.line != null ? { line: raw.line } : {}),
    });
  }
  return { findings: normalized, errors };
}

export function blockingFindings(findings) {
  return list(findings).filter((finding) => BLOCKING.has(finding?.severity));
}

export function findingCounts(findings) {
  const counts = { low: 0, medium: 0, high: 0, blocker: 0 };
  for (const finding of list(findings)) {
    if (finding && counts[finding.severity] != null) counts[finding.severity] += 1;
  }
  return counts;
}

export function validateReviewReport({ status, findings } = {}) {
  const normalized = normalizeFindings(findings);
  const errors = [...normalized.errors];
  if (status === "ready" && blockingFindings(normalized.findings).length) {
    errors.push("ready cannot carry high or blocker findings; report failed instead");
  }
  if (status === "failed" && !blockingFindings(normalized.findings).length) {
    errors.push("a failed review needs at least one high or blocker finding");
  }
  return { ok: errors.length === 0, errors, findings: normalized.findings };
}

export function renderFindings(findings) {
  const listFindings = list(findings);
  if (!listFindings.length) return "";
  return listFindings
    .map((finding) => {
      const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
      const head = `- [${finding.id}] ${finding.severity}${location ? ` ${location}` : ""}`;
      return `${head}\n  problem: ${finding.problem}\n  required fix: ${finding.requiredFix}`;
    })
    .join("\n");
}

/* Paths a worker may never be authorized to touch. The supervisor already
   refuses to edit its own state; this makes the ticket authorization match. */
const PROTECTED_SEGMENTS = new Set([".git", ".orchestration", "secrets"]);

export function protectedPathReason(file, slug = null) {
  const cleaned = String(file ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (!cleaned) return null;
  const segments = cleaned.split("/").filter(Boolean);
  const base = segments[segments.length - 1] || "";
  if (segments[0] === ".git" || segments[0] === ".orchestration")
    return `"${cleaned}" is supervisor or git state`;
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment)))
    return `"${cleaned}" is supervisor state, git state, or secrets`;
  if (base === ".env" || base.startsWith(".env.")) return `"${cleaned}" is an environment file`;
  if (/^id_rsa(?:\.|$)/i.test(base)) return `"${cleaned}" is a private key`;
  if (segments[0] === "orchestration" && (slug == null || segments[1] === slug))
    return `"${cleaned}" is the campaign's own plan and tickets`;
  return null;
}
