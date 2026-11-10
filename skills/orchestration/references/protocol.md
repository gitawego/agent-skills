# Protocol

The mechanics of a campaign once it is running: what a ticket's stage means, how a run starts and ends, how slots and gates decide what happens next, and what the ledger records.

## Stages

A ticket is in exactly one stage. The stage answers one question: **who is this waiting on**. Read the table top to bottom; the first matching row wins.

| Stage | Condition | Waiting on |
| --- | --- | --- |
| `blocked` | A ticket in `blocked_by` is not `done` or `dropped` | Another ticket |
| `queued` | Ready to start, no slot free, or waiting for a human resume to be dispatched | A slot |
| `working` | A run is alive | The worker |
| `needs_answer` | The last report was `needs_answer` | A person or the orchestrator |
| `needs_changes` | A gate failed, or a person sent the work back | A worker, next dispatch |
| `failed` | The run died, or its report was invalid or `failed`, and attempts remain exhausted | A person |
| `done` | Landed, or reported `ready` with no landing needed | Nobody |
| `dropped` | The worker found nothing worth doing | Nobody |

Two invariants: a stage change is always caused by an event in the ledger, and no stage claims a fact another stage contradicts. A run in flight plus a `needs_answer` stage is a bug, not a state.

A ticket that fails and then receives a human answer returns to `queued`, not to `working`, until a supervisor picks it up again.

## Campaign stages

`draft` → `awaiting_approval` → `running` ⇄ `paused` → `delivered` → `archived`. `cancel` stops every live run and lands in `paused`; `archive` is only reachable from `delivered` or `paused`, and only when nothing is alive. `paused` stops dispatch; runs already alive finish, and their gates are evaluated, but nothing new starts. A budget exhaustion, a human pause, and a config error all use `paused`, with the reason on the campaign.

## A run

A **run** is one worker process executing one ticket. Nothing else is a run: not a gate, not a merge, not a tick.

1. **Claim.** The supervisor picks a ticket from the frontier, writes `runs/<run-id>/run.json` with the binding it will use, and moves the ticket to `working`. The claim is the state write; there is no lock file. The binding is read once, at claim, so a config edit can never reach a run that is already alive.
2. **Materialize.** It builds the worktree (branch-landing) or the workspace (directory-landing), writes `prompt.md` from [worker-prompt.md](worker-prompt.md) with the ticket and campaign interpolated, and records the model chain it will try, in order.
3. **Dispatch.** It hands the run to its adapter. The pi adapter spawns `pi` with the run's working directory, an isolated session directory, a stable `--session-id`, the kind's model and thinking level, the kind's tool set, and two `--append-system-prompt` files: the standing [contract](contract.md) and the role file for the kind ([roles/](roles/)). The ACP adapters spawn a small JSON-RPC helper that opens `session/new` (or `session/load` on a resume), applies the model/thinking/mode config, and sends the prompt with the system prompt either as ACP metadata (Antigravity) or a prefix (OpenCode). Stdout and ACP updates are written to `log.jsonl`.
4. **Observe.** While the process lives the run is `working`. The supervisor tails the log for liveness and spend. No new output for `stuck_after_min` counts as stuck.
5. **Collect.** It reads `report.json`. Missing, unparsable, or schema-invalid counts as `failed` with the log tail attached.
6. **Release.** The slot is freed, spend is recorded, the stage is set from the report (and from the gates, if the report says `ready`), and the next frontier ticket may be dispatched.

A run that is killed, by timeout or by `stop`, still goes through collect and release. The slot is never leaked.

### Resuming a parked run

A parked ticket remembers its session id. An answer, or a rejection with findings, is delivered as a new turn in the **same** session (`--session-id` plus the campaign's session directory), so the worker keeps everything it learned and does not re-explore. The only case that starts a fresh session is a new attempt after a `failed` run, because a dead session is untrustworthy.

The answer is delivered as a single turn: the decision, then one line naming what changed. A worker that asked one question gets one answer.

## Reports

`report.json`, written by the worker through `scripts/report.mjs`, validated against this schema.

ACP harnesses report token usage on the prompt response and no dollar cost. The adapter stores it in `session.json`; the supervisor counts tokens and marks the run unmetered rather than pretending it cost zero. A dollar budget therefore cannot cap a subscription adapter, and the panel says so.

```json
{
  "ticket": "03",
  "run": "r-20261109T1803-03-a1",
  "status": "ready",
  "summary": "One paragraph, in the past tense, of what is now true.",
  "question": { "text": "...", "options": ["..."], "default": "..." },
  "checks": [{ "name": "typecheck", "ok": true }],
  "touched": ["src/api/users.ts"],
  "next": "Optional pointer for whoever picks this up."
}
```

| Status | Requires | Meaning |
| --- | --- | --- |
| `ready` | `summary` | The acceptance criteria hold. This is a request for gates, never a claim of done |
| `needs_answer` | `question.text` | One decision is missing and no written source provides it |
| `blocked` | `summary` | Something outside the ticket stops it: a missing credential, a broken dependency, an ambiguous requirement |
| `failed` | `summary` | The worker tried and could not. Its log holds the evidence |
| `dropped` | `summary` | There is no work here, for the reason given |
| `progress` | `summary` | A long ticket checkpointing before it continues. Does not park the ticket |

Rules:

- `needs_answer` without `question.text` is invalid, and invalid is `failed`.
- `checks` is evidence, not authority. The supervisor runs the campaign's checks itself and ignores the worker's claim when they disagree, which is the point.
- `touched` may narrow or widen `touches`, and it updates the conflict map for scheduling.
- A status is never inferred from prose. A run whose final message says "I need you to decide" but whose report says `ready` is `ready`.

## Slots

A ticket holds a slot from claim to release. `max_concurrent` caps slots per campaign; each kind's `max_concurrent` caps its share. A **human resume** may always take one slot above the cap, so a person is never queued behind automation. That extra slot is per campaign, not per kind, and it is the only exception.

The **frontier** is every ticket whose blockers are satisfied, whose stage is `queued`, and whose `touches` do not overlap any live run's touched or declared paths. Dispatch order is ticket number, so a plan that reads top to bottom also executes roughly top to bottom.

A ticket blocked only by `touches` overlap is not `blocked`; it stays `queued` and is simply not dispatchable this tick. The panel shows it as "waiting for a free lane on `src/api/**`".

## Failure and recovery

| Situation | Behavior |
| --- | --- |
| Transient: network, 408, 429, 5xx, a dropped connection | The same model is retried up to 3 times with doubling backoff |
| Model unusable: no credentials, missing from catalog, budget guard | Move to the next model in the chain, same run |
| Chain exhausted | The run is `failed`, one attempt is consumed |
| Timeout: `timeout_min` | Kill the process group, `failed`, slot released, log preserved |
| Stuck: no output for `stuck_after_min` | Same as timeout |
| Invalid or missing report | `failed`, with the last 40 lines of the log attached to the ticket |
| `failed` with attempts left | Back to `queued` once, then the next failure parks it as `failed` for a person |
| Supervisor restarted with a run marked `working` whose pid is gone, and no report on disk | Collected as a failure and retried automatically in a fresh session, under `max_attempts`; the retried prompt tells the worker to read the ticket and the worktree before repeating anything |
| Worker exits 0 with no report | `failed`, never `ready` |

`max_attempts` (default 3) counts dispatches, not retries inside a dispatch. A ticket that exhausts them is a plan problem, and the panel says so.

## The orchestrator's judgement

When a report is `needs_answer` the supervisor does not file it immediately. It first asks the `plan` kind once, with fresh context and only the campaign form, the ticket, the standing decisions, and the question. That run is a **judge**: its report is `ready` with `next: cite: <source> § <section>` when a source answers, and `blocked` when none does:

- **Answered by a source.** The orchestrator answers, quoting the line it relied on, and the run resumes. The ledger records the question, the answer, and the citation. The item never reaches the inbox.
- **Not answered.** One inbox item, with the question, the options, the default, and a one-paragraph brief of what the worker already tried.

The citation requirement is the whole mechanism: an answer that cannot point at a written source escalates. The orchestrator never invents a decision on the human's behalf.

Standing decisions are the third source: the campaign's `decisions.jsonl` plus the promoted console log, written only by the supervisor (see [memory.md](memory.md)). A worker gets the ones whose paths overlap its ticket. Before the judge runs at all, the supervisor looks for a decision with the same normalised question; a hit answers it with no model call.

## Gates

A `ready` report triggers three gates, in order, before a ticket can reach `done`.

1. **Checks.** The supervisor runs every entry in the campaign's `checks` in the ticket's worktree, capturing exit code and the last lines of output. One failure is enough to send the ticket to `needs_changes`, with the failing output as the findings.
2. **Drift.** The supervisor lists the files the ticket branch changed against the integration branch. With `landing: directory` there is no branch, so the ticket's first run snapshots the tree and each later run compares against that snapshot. No files means the work was never committed. A file outside the ticket's `touches` means the change escaped the promise the scheduler used to decide what could run beside it. Either sends the ticket back with the file named.
3. **Review.** A `review` kind run with fresh context reads the diff against `base` (branch landing) or the changed files (directory landing), plus the ticket and the acceptance criteria. It reports `ready` when it has no blocking finding, or `failed` with findings when it does.

A gate run reports its verdict in its own report: `ready` means no blocking finding; `failed` means the findings are in `summary`, which is attached to the ticket verbatim. A gate run that dies without a report fails the ticket rather than passing it, because a broken reviewer must never be mistaken for a clean one.

A failed gate sets `needs_changes`, attaches the findings, and redispatches in the **same worker session** as the changes request. Three gate cycles without passing escapes to a person, because a loop that fails three times is a spec problem.

Bind `review` to a different model than the work kinds. The reviewer that grades its own work is not a gate, and the panel shows which model reviewed what. Approval refuses a review chain whose first model matches a work kind's first model.

## Landing

**Branch landing.** Every ticket branches from the integration branch, never from `base`. Its run merges the integration branch tip in before reporting `ready`, so conflicts surface inside the ticket where the worker can fix them. The supervisor merges the ticket branch into the integration branch after the gates pass, serially, one at a time. A conflicting merge gets one `chores` run in merge mode; a second conflict parks the ticket as `needs_answer` with the conflict as the question.

Delivery also writes `orchestration/<campaign>/CLOSE.md`: landed and dropped tickets, per-ticket model, cost and attempts, the decisions, the checks, and what needed more than one try.

Delivery also prunes: the per-ticket worktrees and `orch/<slug>/<ticket>` branches are removed, because the integration branch already holds their commits. `orch/<slug>/integration` stays as the campaign's record, and a decision whose declared paths no longer exist is retired as `paths-removed`.

A campaign delivers when every ticket is `done` or `dropped`: one result from the integration branch to `base`, by pull request when the base is a protected branch, or by fast-forward when the campaign is `trusted` and the diff is under `max_autoship_lines`.

Approving a delivery item is a merge attempt, not a receipt. If the merge cannot happen — a dirty checkout, a moved base, a conflict — the item stays open, the reason is recorded as `delivery.blocked`, and the same approval can be retried after the cause is fixed.

**Directory landing.** No branches. Each ticket writes into the workspace root; `touches` overlap is the only concurrency control. A passed ticket's files are copied into the delivery directory in ticket order, and the campaign delivers a manifest, not a commit.

What ships follows the autonomy level, and the campaign's `max_autoship_lines` overrides every level: `supervised` always waits for a human; `trusted` ships verified work under the threshold; `unattended` ships anything that passes its gates.

## The ledger

`.orchestration/events.jsonl`, one JSON object per line, appended only. It is the audit trail, the panel's stream, and the source of every count.

```json
{"ts":"2026-11-09T18:03:11Z","campaign":"pocket-museum-v4","ticket":"03","run":"r-...-a1","type":"run.reported","data":{"status":"ready","cost":0.42,"tokens":18422}}
```

Types: `campaign.created`, `plan.drafted`, `campaign.approved`, `campaign.paused`, `campaign.resumed`, `campaign.delivered`, `ticket.added`, `ticket.stage`, `run.dispatched`, `run.reported`, `run.exited`, `run.retried`, `run.stopped`, `gate.check`, `gate.review`, `question.answered`, `inbox.opened`, `inbox.answered`, `merge.done`, `merge.conflict`, `delivery.blocked`, `delivery.rejected`, `spend.recorded`, `error`.

Every event carries the campaign and, where it applies, the ticket and run. A system-wide error carries neither. The ledger is never rewritten; a correction is a new event that names what it supersedes.

## State

`.orchestration/<campaign>/state.json` holds what must survive a restart and must never be hand-edited: each ticket's stage and attempt count, live runs with their pids, session ids and bound model, slot occupancy, spend totals, and the pause reason. It is derived state: if it is lost, it can be rebuilt from the ledger and the reports, and `tick` rebuilds it rather than failing.
