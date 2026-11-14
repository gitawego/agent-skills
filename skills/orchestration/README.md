# Orchestration

Turn one paragraph of intent into a set of independently verifiable tickets,
run each ticket through a worker and a cold review, and land only work that
carries evidence.

Orchestration is an agent skill with a zero-dependency Node supervisor and a
local panel. The agent plans, revises, approves and answers; the supervisor
dispatches, checks, reviews, merges and records. You make the decisions that
need a human, not the command calls.

## Why it exists

A single long agent session loses context, hides what is actually done, and
cannot safely run two things in parallel. Orchestration keeps the plan in git,
runs tickets in isolated worktrees, and makes completion a checked claim:

- every `ready` report needs one passed acceptance result per ticket criterion;
- the supervisor runs its own campaign checks;
- a cold reviewer reports structured findings;
- a review pass is bound to the commit it judged;
- the final integration tip gets one last check before delivery;
- delivery is a computed audit, not “all tickets are done”.

## Requirements

- Node.js 20 or newer
- `git`
- one supported harness: `pi`, `agy` (Antigravity), or `opencode`
- optional: `bwrap` for worker sandboxing, ImageMagick for image downscaling

There is no `npm install`, no `package.json`, no lockfile and no `node_modules`
inside the skill. Runtime state is written to your project and to
`~/.config/orchestration`, never into the skill folder.

## Quick start with an agent

Invoke the skill and describe the outcome. The agent owns the CLI.

```text
/orchestration
```

Or in plain language:

> Use the orchestration skill to add CSV export to the reports page. Context:
> respect the active filters, add no runtime dependency, and document the
> endpoint. Show me the plan before running it.

Then:

1. **Agent:** starts a campaign, saves the context and drafts a plan.
2. **You:** review the ticket table, coverage, assumptions and risks.
3. **You:** “Merge tickets 2 and 3. Keep docs last.”
4. **Agent:** updates the draft and shows only the delta.
5. **You:** “Looks good. Approve and run it.”
6. **Agent:** applies the clean draft, approves the bindings and dispatches.
7. **You:** answer a real question or approve the delivery when asked.

The only normal human decisions are:

- approve a clean plan once;
- answer a question only the human can answer;
- approve or reject the delivery;
- choose whether to clean up after a merge.

## Quick start from the CLI

From the skill directory, once per machine:

```bash
node scripts/orchestrate.mjs link
```

In a project:

```bash
orchestrate init
orchestrate start "Add CSV export to the reports page"
orchestrate context append csv-export --from notes.md
orchestrate plan draft csv-export --file plan.yml
orchestrate approve csv-export
orchestrate run
```

`orchestrate approve` is the common human path: it applies a clean draft,
preflights the model bindings, approves the plan and starts dispatch.

`orchestrate plan import` remains apply-only for explicit or automated flows.

## The loop

```text
start → context → plan draft → review → approve → dispatch
      → work → acceptance → checks → drift → review → merge
      → integration checks → delivery audit → delivery → cleanup
```

### 1. Start

```bash
orchestrate start "<goal>" [--campaign <slug>]
```

Creates `orchestration/<campaign>/campaign.md` and a `draft` campaign.

For an explicit “run it” request:

```bash
orchestrate start "<goal>" --plan-gate auto --autonomy trusted
```

### 2. Context

```bash
orchestrate context append <campaign> --from notes.md
```

Raw input is append-only in `context.md`. It is evidence for the plan, not a
planning trigger. Only an explicit planning request creates tickets.

### 3. Plan

The agent writes `plan.yml`, then:

```bash
orchestrate plan draft <campaign> --file plan.yml
```

The draft command shows:

- the ticket table;
- the delta since the previous draft;
- the delta apply will make;
- coverage of campaign criteria;
- assumptions, open questions and warnings.

Nothing enters `tickets/` until apply.

### 4. Approve

```bash
orchestrate approve <campaign>
```

Approve refuses — and writes nothing — if the draft has:

- a parse or plan error;
- an open question;
- blocking fragmentation;
- an unknown kind;
- a binding or catalog preflight failure.

Otherwise it applies the draft atomically, records the applied audit, approves
the plan and dispatches the frontier.

Use `plan import` when you want apply without approval:

```bash
orchestrate plan import <campaign>
orchestrate plan import <campaign> --submit
```

With `plan_gate: auto`, `--submit` applies and lets the supervisor approve a
clean plan without another human turn.

### 5. Supervise

```bash
orchestrate run     # supervisor + panel, continuous
orchestrate tick    # one pass, safe for cron or a timer
orchestrate up      # start the panel if needed and open it
```

Watch with:

```bash
orchestrate status [campaign]
orchestrate inbox
orchestrate acceptance
orchestrate panel
```

The panel is for monitoring and binary actions. Planning, plan edits and
nuanced answers stay in the agent conversation.

### 6. Deliver

A supervised campaign files a review item instead of merging:

```bash
orchestrate acceptance
orchestrate review <item> approve "Ship it"
```

A trusted or unattended campaign can merge within `max_autoship_lines`. If the
integration branch cannot merge cleanly, the review item stays open and the
reason is recorded as `delivery.blocked`.

After the merge:

```bash
orchestrate cleanup <campaign> --dry-run
orchestrate cleanup <campaign>
orchestrate archive <campaign>
```

Cleanup removes ticket branches, the integration branch and the integration
worktree. It never removes your base branch.

## One-ticket path

Do not build a one-ticket plan pipeline for one outcome.

```bash
orchestrate ticket add "Add --json to status" \
  --campaign csv-export \
  --kind code \
  --touches "src/cli/**" \
  --what "Print structured output for the status command." \
  --accept "status --json parses as JSON" \
  --covers "Status output is scriptable"

orchestrate approve csv-export
```

The ticket still goes through the same acceptance, checks, review and landing
gates.

## Plan file

```yaml
version: 1
goal: Add CSV export to the reports page
brief: Export the current report as CSV without changing the filters.
criteria:
  - Export respects the active filters
  - No new runtime dependency
constraints: No database changes.
assumptions:
  - The reports page already knows the active filter object.
open_questions: []
reading: README.md
tickets:
  - key: export-api
    title: Export endpoint
    kind: code
    touches: [src/reports/**]
    what: Stream the filtered report as CSV.
    accept:
      - GET /reports/export returns a CSV with the active filters
    covers:
      - Export respects the active filters
    sources: [src/reports/service.ts]

  - key: export-ui
    title: Export button
    kind: code
    blocked_by: [export-api]
    touches: [src/pages/reports/**]
    what: Add the download button and wire it.
    accept:
      - Clicking Export downloads a CSV
    covers:
      - Export respects the active filters
    sources: [src/pages/reports.tsx]
```

Rules:

- `assumptions` is required; use `[]` when there is nothing to assume.
- `open_questions` blocks import unless answered or explicitly accepted.
- `covers` is optional. It must match a campaign criterion after trimming and
  whitespace normalization. Missing coverage warns; unknown or duplicate
  criteria are plan errors.
- `touches` is a blast-radius promise. Protected paths — `.git/`,
  `.orchestration/`, `.env` / `.env.*`, `secrets/`, `id_rsa*`, and the campaign’s own
  `orchestration/<slug>/` files — are refused.
- Start with one ticket for one user-visible outcome. Split only when each
  slice is independently demoable and can proceed without a reasoning handoff:
  two or three are normal, four triggers a budget warning, six or more asks for a
  written reason, and 16 is the hard cap.
- Four or more one-path, one-criterion slices are blocking fragmentation unless
  explicitly accepted.
- A blocked ticket receives its completed blockers' summary, reported files and
  acceptance evidence as context, never as authority to widen its scope.
- Generic ticket failures are grouped into one campaign-level inbox item;
  stale-review, integration and delivery failures keep their own item.

## Context handoff

A worker or subagent never inherits a transcript. It gets a bounded packet:

```bash
orchestrate context --ticket 03 --packet > /tmp/context-03.json
```

The packet carries the ticket, completed blockers, verified facts with sources,
decisions, commands already run, artifacts, open questions, paths to read first,
and a `do_not_recheck` list. It is built from recorded evidence only; a summary
alone never becomes a “verified fact”.

Prompts are bounded too: long decisions, dependency summaries, evidence and
reading lists are clipped with an explicit truncation marker, and every run
records `promptChars`, an estimated prompt token count, and dependency/decision
sizes in `run.json`.

## Evidence contract

A work run ends by writing `report.json` through `scripts/report.mjs`.

For a new run (`policyVersion: 2`), a `ready` report must include:

```json
{
  "status": "ready",
  "summary": "The export endpoint now streams filtered rows as CSV.",
  "acceptance": [
    {
      "criterion": "GET /reports/export returns a CSV with the active filters",
      "status": "passed",
      "evidence": "ran the endpoint test with two filter sets; both returned the expected rows"
    }
  ]
}
```

A review report uses structured findings:

```json
{
  "status": "failed",
  "summary": "The filter is dropped on the second page.",
  "findings": [
    {
      "id": "F1",
      "severity": "blocker",
      "file": "src/reports/export.ts",
      "line": 42,
      "problem": "The page parameter is ignored after the first request.",
      "requiredFix": "Pass the page through to the query builder and add a regression test."
    }
  ]
}
```

`ready` may carry low/medium findings. Any high/blocker finding requires
`failed`, and a `failed` review needs at least one high/blocker finding.

The helpers read JSON arrays from the system temp directory:

```bash
node scripts/report.mjs --status ready --summary "..." \
  --acceptance-file /tmp/acceptance.json

node scripts/report.mjs --status failed --summary "..." \
  --findings-file /tmp/findings.json
```

## Gates and delivery

Each `ready` ticket passes, in order:

1. **Acceptance** — one passed result per criterion.
2. **Checks** — the campaign’s configured commands in the ticket worktree.
3. **Drift** — changed files stay inside `touches` and `allow_paths`.
4. **Review** — a cold reviewer on a different model.

A failed gate sets `needs_changes` and resumes the same worker session with the
findings. After three gate cycles the ticket is `failed` for a person; no
repair ticket is created.

A review pass records `reviewedHead` and `reviewedBase`. If the ticket branch
HEAD changes before landing, the pass no longer applies and the ticket is
parked for a fresh review.

Before delivery, branch-landing campaigns run the checks once on the final
`_integration` tip. Delivery is blocked by:

- a ticket that is not done or dropped;
- a done ticket with no passing review;
- a v2 review whose reviewed HEAD no longer matches the branch;
- a branch-landing campaign without a passing integration check at the current
  head;
- plan errors.

Coverage gaps, low/medium findings and same-actual-model reviews are warnings.

## Panel

```bash
orchestrate up
```

The panel shows:

- campaign stage, next action, slots, spend and cache rate;
- the ticket manifest, board and drawer;
- acceptance evidence, findings, reviewed SHA and integration state in the
  ticket drawer;
- draft coverage and **Approve and run** for a clean draft;
- inbox questions, failures and delivery reviews.

The panel never hosts a chat and never calls a model. It enqueues commands; the
supervisor is the only writer of runtime state.

## Files

```text
orchestration/                    # committed
  <campaign>/
    campaign.md                   # goal, brief, criteria, config
    context.md                    # raw human input, append-only
    tickets/01-slug.md            # ticket graph
    CLOSE.md                      # delivery and quality report

.orchestration/                   # gitignored machine state
  events.jsonl                    # append-only ledger
  <campaign>/
    state.json                    # stages, evidence, integration, audit
    plan.yml                      # current draft
    plan.prev.yml                 # previous draft
    plan.applied.yml              # last applied plan
    plan.applied.json             # applied audit
    runs/<run-id>/                # prompt, run record, log, report
    sessions/                     # resumable worker sessions
    worktrees/<ticket>/           # checkout while a ticket runs
    inbox/<item>.json             # questions, failures, delivery reviews
```

## Configuration

Campaign frontmatter controls the run:

```yaml
campaign: csv-export
stage: draft
autonomy: supervised             # supervised | trusted | unattended
plan_gate: human                 # human | auto
landing: branch                  # branch | directory
base: main
checks:
  - name: tests
    cmd: npm test
allow_paths: []                  # generated files outside ticket touches
budget:
  tokens: null
  dollars: null
max_autoship_lines: 200
kinds:
  code:
    models:
      - model: provider/model-id
        thinking: high
```

Model chains are bound per ticket kind. `orchestrate defaults --apply` resolves
the newest usable family; `orchestrate bind` sets one explicitly. A binding
cannot change under a live run without pausing first.

Use `landing: directory` for a project without git branches. There is no
integration worktree; the delivery manifest is the integration artifact.

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Scaffold and register the project |
| `start "<goal>"` | Create a draft campaign |
| `context append <campaign> --from f` | Save raw human input |
| `context --ticket <id> [--packet]` | Read relevant decisions, siblings, diff and history; `--packet` emits a bounded subagent handoff |
| `plan draft <campaign> --file f` | Write and review a draft |
| `plan diff <campaign>` | Reprint the draft delta and coverage |
| `plan show <campaign> [--ticket key]` | Read the draft or applied plan |
| `plan import <campaign> [--submit]` | Apply only; `--submit` ticks |
| `approve <campaign>` | Apply a clean draft, approve, dispatch |
| `ticket add\|edit\|remove` | Change one ticket |
| `run` / `tick` | Supervisor loop or one pass |
| `up` / `panel` | Start or locate the panel |
| `status [campaign]` | Stages, spend, coverage, integration |
| `inbox` | Open questions and failures |
| `acceptance` | Deliveries waiting for review |
| `answer <item> "..."` | Answer a parked worker |
| `review <item> approve\|reject` | Accept a delivery or send it back |
| `cleanup <campaign> [--dry-run]` | Remove campaign branches/worktrees |
| `archive <campaign>` | Close a delivered campaign |

`orchestrate help` prints the full list.

## Development

From this directory:

```bash
node --test tests/*.test.mjs

ORCH_E2E_CHROME=/path/to/google-chrome \
  node --test tests/panel.e2e.mjs

node evals/run.mjs
```

Tests use a disposable project, a scripted worker and an isolated XDG config;
they do not touch your real campaigns.

Key references:

- [SKILL.md](SKILL.md) — the agent-facing skill
- [references/protocol.md](references/protocol.md) — stages, reports, gates, landing
- [references/config.md](references/config.md) — campaign and ticket schema
- [references/panel.md](references/panel.md) — panel behavior
- [docs/SPEC.md](docs/SPEC.md) — design decisions
- [docs/ADR-001-ticket-sizing-and-context.md](docs/ADR-001-ticket-sizing-and-context.md) — one-ticket default, dependency context, failure aggregation
- [docs/ADR-002-bounded-context-packets.md](docs/ADR-002-bounded-context-packets.md) — subagent handoff packets, prompt budgets, context telemetry
- [docs/SPEC-evidence-and-approval.md](docs/SPEC-evidence-and-approval.md) — evidence and one-decision approval spec

## When not to use it

- One small edit, one file, one obvious change — just do it, or use one ticket
  rather than a multi-ticket campaign.
- An idea that still needs discovery — use a research or wayfinding flow first.
- Work whose only output is a decision — ask for the decision.
- A plan you cannot describe in independently verifiable slices — the graph is
  not ready yet.
