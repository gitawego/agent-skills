# Spec: Evidence-bound tickets and one-decision planning

Status: **implemented** (all four phases)  
Date: 2026-11-11  
Scope: `skills/orchestration`  
Evidence: `tests/evidence.test.mjs`, `tests/report.test.mjs`, `tests/engine.test.mjs`, `tests/plan-import.test.mjs`, `tests/plan-draft.test.mjs`, `tests/panel.e2e.mjs`, `evals/run.mjs`  
Read first: [`SPEC.md`](SPEC.md), [`../SKILL.md`](../SKILL.md), [`../references/protocol.md`](../references/protocol.md)

## 1. Summary

This spec closes two gaps that surfaced while comparing the orchestration
skill with `dsh-agent-teams`:

1. **A ticket's completion is still mostly prose.** The supervisor runs checks
   and a cold review, but the worker does not have to submit evidence for the
   ticket's own acceptance criteria, and review findings are free-form text.
2. **A clean plan takes two human decisions.** A human reviews a draft, runs
   `plan import`, then runs `approve`. The panel cannot apply the draft.

The target is:

> **The agent drafts the ticket graph; the human makes one decision. A ticket
> is done only when its acceptance criteria and review evidence are attached to
> the revision that actually lands.**

This is an adaptation of the useful parts of `dsh-agent-teams`, not a copy of
its team runtime. We keep our worktrees, single supervisor, report protocol,
inbox, slots, quotas and attention model. We deliberately do **not** add its
quality-task DAG, repair tickets, attempt IDs, mailboxes, or full artifact
digest system.

## 2. Problem

### 2.1 Completion can be claimed without evidence

A worker can report `ready` with a summary, and the supervisor then relies on:

- campaign checks, which prove the configured commands pass, not that every
  ticket acceptance criterion is covered;
- a review run, which reads the diff and the criteria but reports findings as
  a formatted string.

This works, but it leaves the human acceptance review doing work the runtime
could do:

- “Did the worker actually address every acceptance criterion?”
- “Which findings were blocking, and which were optional?”
- “Was the review of the code that landed?”

### 2.2 A review is not bound to a revision

The review run reads the ticket branch, then the supervisor merges the branch.
The run record stores the model and prompt, but not the commit the review
judged. A branch changed after review, by a person or a leftover process, can
still be merged under the review's `pass`.

### 2.3 There is no final integration check

Every ticket runs the campaign checks in its own worktree. When all tickets are
done, the supervisor merges them serially and delivers. It does not run the
checks on the final integration tip. Two tickets can each pass and still break
the combined branch.

### 2.4 The plan happy path has unnecessary ceremony

For a clean human-gated plan the current sequence is:

```text
plan draft → review → plan import → approve → dispatch
```

`plan import` and `approve` are separate because the plan is committed before
approval. The separation is useful for `plan_gate: auto` and for explicit
apply-only workflows, but for the common human path it makes one decision look
like two.

### 2.5 Criteria are not mapped to tickets

The campaign document has acceptance criteria, and every ticket has its own
`accept` list, but nothing checks that a campaign criterion is covered by at
least one ticket. The plan's “done” condition is a human judgement.

## 3. Goals

- Require machine-readable acceptance evidence for every `ready` work report.
- Make review findings structured, with severity and a required fix.
- Bind a passing review to the commit it judged.
- Run the campaign checks on the final integration tip before delivery.
- Make a delivery a computed audit over evidence, not just “all tickets done”.
- Make a clean human plan one decision: review the draft, then approve and run.
- Show coverage of campaign criteria without adding another approval gate.
- Keep the worker/session repair loop; do not add repair tickets.
- Keep the panel quiet; new evidence is collapsed or shown only when relevant.
- Add no new per-campaign setting.

### Attention budget

This spec adds **no new question and no new setting**. The only new human
decision is the existing plan approval, which becomes one action instead of
two. A failed integration check creates one failure item, not a new queue. A
missing coverage mapping is a warning, not a gate. Evidence lives in the
ticket drawer and `CLOSE.md`, not in a new always-visible panel band.

## 4. Non-goals

Do **not** build:

- `dsh-agent-teams`-style `requirements` / `implementation` / `verification` /
  `review` / `integration` task kinds.
- Automatic `repair-round-N` and `review-round-N+1` tickets. A failed gate
  resumes the same ticket in the same worker session; that is the repair.
- Per-ticket `commandsRun` as authority. The supervisor's checks remain the
  authority; the worker reports acceptance evidence only.
- Full artifact digests/hashes for every reviewed file. A reviewed commit SHA
  plus the final integration check is enough for this architecture.
- Attempt IDs, leases, or member mailboxes. The supervisor is the only writer.
- A multi-agent chat surface or a plan editor in the panel. The panel may show
  the draft and one binary “Approve and run” action; editing stays in chat.
- A hard coverage gate. Coverage is a warning and a visible matrix in v1.
- A new quality mode, risk tier, or review-round setting.

## 5. Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | The agent drafts tickets; it never commits a plan without approval. `context append` is input, not a planning trigger. | Keeps the adaptive decomposition while preserving the human commitment point. |
| 2 | The supervisor never invents tickets. Only `plan draft`, `ticket add`, and explicit plan edits create them. | The scheduler dispatches; it does not decide scope. |
| 3 | `approve` applies a clean draft if one exists, then approves. `plan import` remains apply-only. | One human command for the common path; `plan import` stays available for auto and explicit apply. |
| 4 | A clean draft means: no draft error, no open questions, no blocking fragmentation, no missing binding, no plan errors. | “Approve” must not silently accept a draft that still needs a decision. |
| 5 | Work `ready` requires one passed acceptance result for every ticket `accept` item. | Makes completion a checked claim, not a summary. |
| 6 | Failed acceptance results require `failed`, not `ready`. | A partial pass is not a pass. |
| 7 | Review findings are structured: id, severity, problem, requiredFix, optional file/line. | Findings can drive the resume prompt and the panel without prose parsing. |
| 8 | A review may pass with low/medium findings; high/blocker findings force failure. | Keeps style noise non-blocking while making real blockers explicit. |
| 9 | A review `failed` report requires at least one high/blocker finding. | A gate that fails without a fix direction is not actionable. |
| 10 | A passing review records the ticket branch HEAD and integration base it judged. | A pass applies to a revision, not a ticket id. |
| 11 | The ticket branch HEAD must still equal the reviewed HEAD at merge. | Prevents stale review evidence from blessing a changed branch. |
| 12 | Branch-landing campaigns run the campaign checks once on the final `_integration` tip before delivery. | Per-ticket checks cannot catch cross-ticket breakage. |
| 13 | Integration-check failure pauses the campaign with one failure item; it does not auto-create repair work. | The person decides whether to add a fix ticket or amend the branch. |
| 14 | Delivery is blocked unless the delivery audit passes. | “All tickets done” is necessary but not sufficient. |
| 15 | `covers` maps tickets to campaign criteria; uncovered criteria warn but do not block. | Visibility without another approval decision. |
| 16 | The review stays a run, not a ticket. | Preserves the existing stage model and avoids a second task system. |
| 17 | A gate failure still increments `gateCycles` and resumes the same session; three cycles fail the ticket for a person. | The existing repair loop is simpler than dsh's generated repair graph. |
| 18 | New runs use evidence contract v2; in-flight runs started before the upgrade use the legacy path. | Avoid breaking a parked campaign mid-upgrade. |
| 19 | Protected paths cannot appear in `touches` or `allow_paths`. | A worker cannot be authorized to edit supervisor state, git internals, or secrets. |
| 20 | No new settings. All new behavior is default. | Attention economy: a setting that only configures correctness is a tax. |

## 6. Target flows

### 6.1 Multi-ticket campaign, human gate

```text
human: goal + context
  → agent: context append (optional)
  → agent: plan draft        # tickets/, campaign.md untouched
  → human: reviews the compact plan, coverage, one risk line
  → human: approve           # applies the clean draft, approves, dispatches
  → supervisor: work → checks → review → merge
  → supervisor: integration checks
  → delivery (manual, trusted, or unattended)
```

`approve` is the single decision. It refuses if the draft still has an open
question, a blocking warning, a plan error, or an unbound chain.

### 6.2 One-ticket request

```text
agent: ticket add "<one outcome>" ...
human: approve
```

A one-ticket campaign does not need a draft/diff/import ceremony. The plan
still has a ticket contract and the same gates.

### 6.3 Revision

```text
agent edits plan.yml
  → plan draft / plan diff   # show only the delta
  → approve                  # applies and approves
```

`plan.prev.yml`, `plan.applied.yml`, and `plan.applied.json` remain internal.
They are available through `plan audit`, but are not part of the first-run
story.

### 6.4 Explicit “run it”

```text
agent: start --plan-gate auto
agent: plan draft
agent: plan import --submit
```

`--submit` applies and runs a tick; with `plan_gate: auto` the supervisor
approves a clean plan. No second human turn. A draft with open questions or
blocking warnings still needs a person.

### 6.5 Gate failure

```text
checks fail or review fails
  → findings attached to the same ticket
  → same worker session resumes with the findings
  → checks and a fresh review run again
  → after 3 gate cycles: ticket failed, added to the campaign failure digest
```

No repair ticket is created. The review run is independent and always uses a
fresh review session.

### 6.6 Delivery

```text
all tickets done/dropped
  → delivery audit
  → integration checks on the final tip
  → manual review item, or trusted/unattended delivery
  → cleanup question after merge
```

## 7. Ticket generation rules

These are product rules for the agent and prompt, not a new CLI feature.

- Generate tickets only on an explicit planning request or an explicit plan
  change. A passive `context append` must not create tickets.
- One ticket is one independently verifiable outcome, not one file, one layer,
  one paragraph, or one step. Start with one ticket.
- Split only when each slice is independently demoable and can proceed without
  a reasoning handoff. Two or three are normal for independent parallel work;
  four triggers a budget warning; six or more asks for a written reason; sixteen
  is refused. See `ADR-001-ticket-sizing-and-context.md` for the decision.
- Do not create tickets for “review”, “verification”, “context”, or “process”.
  Review is a gate; context is input.
- Do not create “prepare” and “use it” pairs. Merge them unless each is
  demoable alone.
- If the request has one outcome, use `ticket add`; do not build a plan with one
  ticket just to use the plan pipeline.
- Never generate a ticket per file or per context chunk.

## 8. Data model

### 8.1 Plan and ticket

Add an optional `covers` field to a ticket:

```yaml
criteria:
  - The shell starts in under 200 ms
  - No new runtime dependency

tickets:
  - key: startup
    covers:
      - The shell starts in under 200 ms
  - key: dependency-audit
    covers:
      - No new runtime dependency
```

Rules:

- `covers` is optional. Its absence produces a coverage warning, not a plan
  error.
- If present, every entry must exactly match a campaign criterion after
  trimming and whitespace normalization. An unknown entry is a plan error.
- Campaign criteria must be unique. Duplicate criteria are a plan error.
- A ticket may cover multiple criteria; a criterion may be covered by multiple
  tickets.
- `covers` is included in the draft, applied plan, audit, and `tickets/`
  frontmatter. It is not a new workflow stage.

No `version` bump: `version: 1` remains; the field is additive.

### 8.2 Work report

Extend `report.json` for new work runs:

```json
{
  "status": "ready",
  "summary": "The CLI now supports add and list.",
  "acceptance": [
    {
      "criterion": "add prints added",
      "status": "passed",
      "evidence": "ran `node cli.mjs add x`; stdout was `added`"
    }
  ]
}
```

`acceptance` is an array of:

```ts
{
  criterion: string
  status: "passed" | "failed"
  evidence?: string
}
```

Rules:

- A `ready` report must contain exactly one result for every ticket `accept`
  criterion, matched by exact criterion text after trimming.
- Every result must be `passed`. A failed result requires `status: "failed"`.
- Duplicate results, missing results, unknown criteria, or a missing
  `acceptance` array make the report invalid.
- An invalid report is collected as `failed`, with the validation error
  attached, exactly like a malformed report today.
- The supervisor's checks remain authoritative and are still run. Acceptance
  evidence does not replace a check.
- `acceptance` is optional for `failed`, `blocked`, `needs_answer`, `dropped`,
  and `progress` reports.

`report.mjs` gains:

```text
--acceptance-file <path>   JSON array of acceptance results
```

The file is read and validated; it is not copied into the worktree. The
existing simple flags remain for summary/status. A worker can put the file in
the system temp directory.

### 8.3 Review report

A review report may include findings:

```json
{
  "status": "failed",
  "summary": "The add command drops the last argument.",
  "findings": [
    {
      "id": "F1",
      "severity": "blocker",
      "file": "src/cli/add.ts",
      "line": 42,
      "problem": "argv is sliced twice, so the final argument is lost.",
      "requiredFix": "Slice argv once before parsing; add a regression test."
    }
  ]
}
```

Finding fields:

```ts
{
  id: string                 // required; stable within this review
  severity: "low" | "medium" | "high" | "blocker"
  problem: string            // required
  requiredFix: string         // required
  file?: string
  line?: number
}
```

Rules:

- `ready` with any `high` or `blocker` finding is invalid; it must be `failed`.
- `ready` may carry `low`/`medium` findings; they are recorded as warnings.
- `failed` for a review run requires at least one `high` or `blocker` finding.
- A review failure with only low/medium findings should be reported as `ready`
  with warnings, not `failed`.
- Findings are stored on the ticket in `state.tickets[id].findings` as an
  array. The old string form is still rendered for existing campaigns.
- A review `failed` without findings is invalid and is collected as a failed
  gate with the validation error, not as a pass.

`report.mjs` gains:

```text
--findings-file <path>     JSON array of findings
```

The prompt tells reviewers to write this file in the system temp directory.

### 8.4 Gate/retry semantics

- `gateCycles` still counts check or review failures.
- A failed review or check sets `needs_changes`, stores findings, and resumes
  the same worker session.
- After three gate cycles the ticket becomes `failed` and joins the campaign's
  `gate-cycles` failure digest; no repair ticket is created. The digest names
  every affected ticket and keeps each ticket's findings under its own heading.
- The resume prompt uses structured findings when present:

```text
Your work was reviewed and sent back. Blocking findings:

- [F1] blocker src/cli/add.ts:42
  problem: argv is sliced twice...
  required fix: Slice argv once...
```

- If the gate failure is a check failure with no review findings, the existing
  textual findings path remains.

### 8.5 Runtime state

Add to a ticket entry in `state.json`:

```ts
{
  acceptance?: AcceptanceResult[]     // last work report
  findings?: ReviewFinding[] | string  // array for new runs, string for legacy
  reviewedHead?: string               // branch commit the passing review judged
  reviewedBase?: string               // integration head at review start
  reviewModel?: string
  workerModel?: string
  reviewStale?: boolean
  reviewRound?: number
}
```

Add to campaign state:

```ts
{
  integration?: {
    head: string | null
    status: "passed" | "failed"
    at: string
    checks: { name: string; ok: boolean; output: string; ms: number }[]
  }
  deliveryAudit?: {
    ok: boolean
    blockers: string[]
    warnings: string[]
    at: string
  }
}
```

`state.tickets[id].findings` may be a string for campaigns created before this
spec. New code writes arrays; the view renders both.

### 8.6 Run record

Add to a work/review run record:

```ts
{
  policyVersion: 2                 // new runs only
  reviewedHead?: string            // review runs
  reviewedBase?: string            // review runs
  reviewedModel?: string
  workerModel?: string             // copied from the work run being reviewed
}
```

A run without `policyVersion: 2` is legacy: missing acceptance and missing
reviewed commits do not retroactively fail it. This keeps an in-flight campaign
from breaking across an upgrade. A new run always gets `policyVersion: 2`.

### 8.7 Ledger events

Existing events keep their shape where possible. Add or extend:

```json
{"type":"gate.review","data":{"result":"pass","reviewedHead":"abc123","findings":0}}
{"type":"gate.integration","data":{"result":"pass","head":"def456","checks":[...]}}
{"type":"gate.integration","data":{"result":"fail","head":"def456","checks":[...]}}
{"type":"delivery.blocked","data":{"blockers":["..."]}}
{"type":"ticket.amended","data":{"fields":["accept"],"reason":"..."}}
```

`gate.check` keeps its existing `result`/`findings` fields.

## 9. Semantics

### 9.1 Approval

`approve <campaign>` becomes the single clean-plan decision.

1. If a draft exists:
   - read and normalize it;
   - refuse on draft error, open questions, blocking fragmentation, unknown
     kind, or any plan validation error;
   - preflight the binding/catalog validation against the draft graph;
   - if preflight passes, apply the draft atomically;
   - then approve.
2. If no draft exists:
   - validate and approve the applied plan as today.
3. If the draft cannot be applied or approval cannot succeed, write nothing and
   return the same actionable errors.

`plan import` remains apply-only. `plan import --submit` remains the auto-plan
path. `plan_gate: auto` behavior is unchanged; `--submit` can still auto-approve
a clean plan without a human turn.

`approve` must be idempotent: calling it on an already approved/running plan
does not duplicate tickets or events.

### 9.2 Work completion

A work report `ready` is accepted only when:

- every ticket `accept` criterion has one passed result;
- the report passes the existing schema validation;
- the supervisor's checks pass (as today);
- the diff stays inside `touches` (as today).

A `ready` missing evidence is invalid and becomes a failed run with the
validation error attached. A `failed` report with failed acceptance results is
valid and follows the existing failure path.

### 9.3 Review gate

The review run is unchanged in role and model separation. It now reports
structured findings.

- `pass` = `ready`, no high/blocker findings.
- `fail` = `failed`, at least one high/blocker finding.
- Low/medium findings on a pass are recorded but do not block.
- The reviewer still cannot edit, commit, or run mutating commands.

### 9.4 Review commit binding

For branch landing:

1. At review start, record:
   - `reviewedHead = git rev-parse HEAD` in the ticket worktree;
   - `reviewedBase = git rev-parse <integration-branch>` in the project.
2. On a review `pass`, re-read the ticket branch HEAD.
3. If it differs from `reviewedHead`, do not merge. Set the ticket to `failed`
   with a failure item: “The branch changed after review; the review no longer
   applies. Re-review the current revision.”
4. Immediately before the merge, check the branch HEAD again. A mismatch has
   the same result.
5. Record `reviewedHead` on the `gate.review` event and in CLOSE/panel.

For directory landing there is no commit. The review still reads the declared
files and the delivery manifest records the review as file-based evidence; no
`reviewedHead` is written.

### 9.5 Final integration check

For branch landing, when every ticket is `done` or `dropped`:

1. Ensure the `_integration` worktree exists at the current integration branch
   tip.
2. Run the campaign `checks` there once.
3. Record `state.integration` and a `gate.integration` event.
4. If the checks pass, continue to delivery.
5. If a check fails:
   - pause the campaign with reason `integration checks failed`;
   - create exactly one failure item with the failing output;
   - do not deliver;
   - do not auto-create a repair ticket.
6. `resume` clears a failed integration observation so the same head gets one
   fresh check; a repeated failure at the same head does not spawn duplicate
   items. If the integration head changed, the next tick checks the new head.

For directory landing, skip the integration worktree check. The delivery
manifest is the campaign's integration artifact; per-ticket checks already ran
against the shared workspace.

### 9.6 Delivery audit

Replace the “all tickets done → deliver” condition with an audit:

```text
deliveryAudit(campaign):
  blockers:
    - any ticket not done/dropped
    - any done ticket with no passing review (branch landing)
    - any v2 passing review whose reviewedHead != current ticket branch head
    - any branch-landing campaign without a passing integration check at
      the current integration head
    - stale v2 review evidence
    - a plan error that prevents a valid graph
  warnings:
    - uncovered campaign criteria
    - low/medium review findings
    - review performed by the same actual model as the worker
```

- If blockers exist: do not deliver; pause the campaign with reason
  `delivery audit failed`, create one failure item (deduplicated), and emit
  `delivery.blocked`.
- A legacy (pre-v2) passing review with no `reviewedHead` is reported as an
  `unbound review` warning, not a blocker. It was produced before this contract
  existed; the panel says so.
- If only warnings exist: deliver and record them in CLOSE/panel.
- The manual delivery review item includes the audit summary and the reviewed
  commit(s).
- `review.approve` still merges; it is a delivery action, not a receipt.

### 9.7 Coverage

- `plan draft` prints a compact coverage warning:
  `coverage: 3/4 criteria claimed; missing: <criterion>`.
- `plan import` prints the same warning; it does not fail.
- The panel shows a coverage matrix in the draft and applied plan views.
- CLOSE records the matrix and missing criteria.
- Coverage does not block approval or delivery in v1. It is a warning because a
  criterion can be a global constraint (for example “no new dependency”) that
  does not map cleanly to one ticket.

### 9.8 Protected paths

`touches` and `allow_paths` may not match:

- `.git/`
- `.orchestration/`
- `.env`, `.env.*`
- `secrets/`
- `id_rsa*`
- `orchestration/<campaign>/` (the campaign plan/tickets themselves)

These are plan validation errors. The supervisor already refuses to edit
`.orchestration`; this makes the worker authorization match that rule. A
campaign that needs to change its own plan goes through the plan commands, not
a worker.

### 9.9 Reviewer independence

The existing approval rule still refuses a review chain whose first model
matches a work kind's first model.

Add a runtime warning when the **actual** review model equals the **actual**
work run's model, including fallback selections. If the review chain has another
usable model, use it; otherwise proceed and record a warning in the gate,
panel, and CLOSE. Do not fail solely for model equality.

## 10. CLI and API

| Surface | Change |
| --- | --- |
| `approve <campaign>` | Applies a clean draft, then approves. One command for the human path. |
| `plan import` | Unchanged: apply-only. |
| `plan import --submit` | Unchanged: apply + tick; auto gate may approve. |
| `plan draft` / `plan diff` | Print coverage warning; keep compact by default. |
| `ticket edit` | Phase 3: add optional `--reason`; refuse on `working`; record an amendment event. No new stage. |
| `status` | Show integration state and review/coverage warnings in the quality summary. |
| `review` | The delivery review shows the audit and reviewed head. |
| Panel approve action | Enabled for a clean draft as well as `awaiting_approval`; calling it applies + approves. |

`plan import --approve` is **not** added. `approve` is the decision. The
existing `--submit` remains the explicit auto path.

## 11. Panel

The panel remains a monitoring/configuration surface.

- Draft card: show `Approve and run` when the draft is clean; show the blocking
  reason and keep the copyable command when it is not.
- Draft card: show coverage summary and missing criteria.
- Ticket drawer: collapsed **Evidence** section with:
  - acceptance results and evidence;
  - findings grouped by severity;
  - review model and short reviewed commit;
  - gate cycles and integration status.
- Campaign header: small `reviewed <sha>` and `integration passed/failed` chips.
- No plan editor. Editing stays in chat.
- No new always-visible panel section; evidence is inside the existing drawer.

## 12. Close report

Add to `CLOSE.md`:

```markdown
## Quality

- integration: passed at <sha> (2 checks)
- reviewed: 03 at <sha>, 04 at <sha>
- findings: 2 low, 0 high
- coverage: 4/4 criteria claimed
```

Keep the existing attention section. Do not add per-ticket evidence paragraphs;
the ticket table remains compact.

## 13. Compatibility and rollout

- `policyVersion: 2` is written on new work/review runs. Runs without it keep
  the legacy report behavior, so an in-flight campaign does not break during an
  upgrade.
- Existing `state.tickets[id].findings` strings are rendered as before. New
  findings are arrays.
- Plans without `covers` are valid; they produce a coverage warning after this
  change.
- `approve` semantics change from “refuse if a draft exists” to “apply a clean
  draft, then approve.” This is documented in SKILL.md and the CLI help.
- `plan.applied.yml` remains the snapshot at the last apply. Ticket edits made
  through `ticket edit` after that are recorded in the ledger and shown by
  `plan audit`; they do not rewrite the applied snapshot.
- No database, no new dependency, no new setting.

## 14. Implementation touchpoints

| File | Change |
| --- | --- |
| `scripts/report.mjs` | `--acceptance-file`, `--findings-file`, validation, error messages. |
| `scripts/lib/plan-import.mjs` | `covers` field, criterion uniqueness, coverage warnings, protected-path validation. |
| `scripts/lib/plan-draft.mjs` | Canonical `covers`, draft/applied diff, coverage summary, audit. |
| `scripts/lib/state.mjs` | Ticket evidence fields, integration state, delivery audit state. |
| `scripts/lib/engine.mjs` | Work evidence validation, review findings, reviewed HEAD, integration check, delivery audit, approval preflight/apply. |
| `scripts/lib/prompts.mjs` | Acceptance/finding instructions, reviewed-head context, structured resume prompt. |
| `scripts/lib/view.mjs` | Coverage, evidence, integration and audit fields; next-action condition. |
| `scripts/orchestrate.mjs` | `approve` behavior, coverage output, status quality summary, help text. |
| `assets/ui/app.js` | Approve-and-run, coverage matrix, evidence drawer, integration/reviewed badges. |
| `references/protocol.md`, `references/panel.md`, `references/contract.md`, `references/roles/review.md` | Document the new contract and the one-action approval. |
| `SKILL.md` | Five-loop wording: draft once, one approval, evidence, integration. |
| `tests/*.test.mjs`, `tests/panel.e2e.mjs`, `evals/` | New acceptance, review, integration and approval cases. |

## 15. Implementation order

### Phase 1 — Evidence and findings

1. Extend `scripts/report.mjs` with `--acceptance-file` and
   `--findings-file`, validation, and tests.
2. Extend `normalizePlan`/ticket rendering with `covers` and criterion
   uniqueness.
3. Extend `collectWork` to validate acceptance evidence for `policyVersion: 2`.
4. Extend `collectReview`/`sendBack` to store and resume with findings.
5. Update review prompt, worker prompt, contract, protocol, and panel rendering.
6. Add engine tests for missing/failed/extra acceptance, review findings, and
   legacy run behavior.

### Phase 2 — Revision binding and delivery audit

1. Capture `reviewedHead`/`reviewedBase` in `startReview`.
2. Check the head before landing and before merge; stale reviews park as failed.
3. Add the integration check in `maybeDeliver`; pause on failure with one item.
4. Add `deliveryAudit`; route `maybeDeliver` through it.
5. Add `gate.integration`, `delivery.blocked`, and CLOSE/panel output.
6. Add tests for stale review, integration failure, recovery on resume, and
   no duplicate failure items.

### Phase 3 — One-decision approval and coverage

1. Change `approveCampaign` to preflight and apply a clean draft.
2. Update CLI help, SKILL.md loop, and panel approve conditions.
3. Add coverage matrix to view, draft, applied plan, and CLOSE.
4. Update `deriveNextAction` so a clean draft offers “Approve and run.”
5. Add panel e2e for approving a draft directly.

### Phase 4 — Small hardening

1. Protected-path validation for `touches`/`allow_paths`.
2. Actual-review-model warning.
3. `ticket edit --reason` and amendment event, if still needed after Phases
   1–3.
4. Update evals for the new happy path and one failure path.

## 16. Verification

Unit tests:

- `report.mjs` accepts a valid acceptance file and rejects missing, duplicate,
  unknown, or failed-as-ready results.
- Review findings validation: ready+blocker invalid; failed+no findings invalid;
  low/medium pass allowed.
- Engine: a `ready` without acceptance cannot reach `done`.
- Engine: a passing review with a changed branch head cannot merge.
- Engine: integration check failure pauses, opens one item, and does not
  deliver; resume after a new head can deliver.
- Engine: `approve` applies a clean draft, refuses open/blocked drafts, and
  does not leave applied tickets on a preflight failure.
- Plan: duplicate criteria and unknown `covers` fail; missing `covers` warns.
- Scope: protected paths are refused.
- Legacy: a `policyVersion`-less run still accepts the old report shape.

Browser e2e:

- A clean draft shows **Approve and run**; one click applies and dispatches.
- A draft with an open question has no approve action and shows the reason.
- The ticket drawer shows acceptance evidence, findings, reviewed SHA, and
  integration state.
- A failed integration shows one failure state, not a delivery review.

Evals:

- Add one case for a plan generated from context with one ticket and one with
  four tickets, asserting the ticket count and coverage warning.
- Add one case for a missing evidence report and one for a stale review.

Run:

```bash
node --test tests/*.test.mjs
ORCH_E2E_CHROME="$(command -v google-chrome)" node --test tests/panel.e2e.mjs
node evals/run.mjs
```

## 17. Open questions

None blocking. The following are explicit decisions, not open questions:

- Coverage warns in v1; it does not block.
- Integration failure pauses with one failure item; it does not auto-repair.
- `approve` applies a clean draft; `plan import` remains apply-only.
- Findings and acceptance evidence are mandatory for new runs only.
- No repair tickets, no new quality kinds, no plan editor.
