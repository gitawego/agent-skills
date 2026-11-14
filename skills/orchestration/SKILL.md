---
name: orchestration
description: Plan a complex, multi-ticket campaign, bind a model to each ticket kind, dispatch parallel worker agents under slots, quotas and worktrees, park real questions in one inbox, accept deliveries in one queue, and land verified work. Ships a local fleet panel that shows every campaign live.
disable-model-invocation: true
---

# Orchestration

A **campaign** turns one paragraph of intent into landed work. You plan it as **tickets** with blocking edges, approve the model binding for each **ticket kind**, then a supervisor dispatches **runs** in parallel, up to its **slots** and provider quota windows. Questions stop at the **inbox**; finished deliveries wait in **acceptance**; work that passes its **gates** lands.

The supervisor is a zero-dependency Node process (`scripts/orchestrate.mjs`) plus a local panel. For the human-facing guide, see [README.md](README.md).

## Attention

Take as little human attention as possible, and give as much value as possible. Every message, question, setting and panel element must earn its cost.

- **One approval per campaign.** If `plan_gate: auto` and the draft is clean — no open questions, no blocking warnings, no high-risk path, chains bound — import without a second ask and let the supervisor approve.
- **One question at a time.** Ask only what changes the ticket graph; batch only independent facts.
- **Speak when a person must act or a result is ready.** No progress chatter; healthy state stays quiet.
- **One delivery decision.** Ask `open a PR` or `merge locally`; after a merge, one cleanup question, with removal as the default when the branch is safe.

Read the reference for a branch before acting on it:

- [references/config.md](references/config.md): campaign document, ticket kinds, model chains, budget, inheritance, validation.
- [references/protocol.md](references/protocol.md): stages, ticket files, report schema, slots, retries, gates, landing, events.
- [references/contract.md](references/contract.md): the standing rules appended to every worker's system prompt.
- [references/roles/](references/roles/): one contract per kind — code, design, visual, research, plan, chores, review, judge, merge.
- [references/panel.md](references/panel.md): screens, actions, HTTP and SSE surface.
- [docs/ADR-001-ticket-sizing-and-context.md](docs/ADR-001-ticket-sizing-and-context.md): one-ticket default, dependency context, failure aggregation.
- [docs/ADR-002-bounded-context-packets.md](docs/ADR-002-bounded-context-packets.md): subagent handoff packets and prompt budgets.
- [references/memory.md](references/memory.md): decisions, supersession, promotion, the context command, the close report.
- [references/worker-prompt.md](references/worker-prompt.md): what a worker is told.

## When to use it

Use it when the work is larger than one context window and can be split into slices that are each verifiable on their own: a feature spanning schema, API, UI, and tests; a migration; a design or research effort with several deliverables.

Start with **one ticket for one outcome**. Use a multi-ticket campaign only when the slices are independently verifiable and can proceed without a reasoning handoff. An idea still too foggy to slice is `/wayfinder`. Work whose only output is a decision is `/grilling`.

## The loop

Five steps. Each has a completion criterion; do not start the next until it holds.

### 1. Start

The human invokes `/orchestration start <goal>`. Scaffold if this project has no campaign yet (`node scripts/orchestrate.mjs init`), then create a `draft` campaign holding the goal. If the human says “run it”, start with `--plan-gate auto --autonomy trusted`; a clean draft can then be imported with `--submit` without a second approval.

**Done when:** `orchestration/<campaign>/campaign.md` exists with a one-sentence goal, and the campaign stage is `draft`.

### 2. Plan

Take the human's free-form context — notes, links, constraints, prior attempts, screenshots — and persist it with `orchestrate context append <campaign> --from notes.md`. It lands in `orchestration/<campaign>/context.md` as raw, timestamped input; the brief is your synthesis, the context is the source.

Then write a **draft** plan: goal, brief, acceptance criteria, constraints, assumptions, open questions, reading list, and the **tickets**. Each ticket is a vertical slice, sized to one fresh context window, declaring the tickets that **block** it, the paths it **touches**, the campaign criteria it **covers**, and the **sources** it came from.

Save the draft with `orchestrate plan draft <campaign> --file plan.yml`. It validates the plan, snapshots the previous draft, and prints the table, the delta since the last draft, the delta apply will make, coverage, assumptions, open questions and actionable warnings. Show that in chat; revisions are another `plan draft`, and you present the delta. Nothing enters `tickets/` until apply.

If the human asked to run the campaign and `plan_gate: auto`, present a compact draft once and run `plan import --submit`; do not ask for a second approval. With `plan_gate: human`, the clean draft is approved in one action: `orchestrate approve <campaign>` applies the draft atomically and starts dispatch. It refuses if the draft has an error, an open question, blocking fragmentation, or a binding preflight failure, and writes nothing in that case.

`orchestrate plan import <campaign>` remains the apply-only command. It refuses while anything is running, requires `assumptions`, and blocks on open questions unless `--accept-open` is passed. Re-import is idempotent by ticket `key`. `approve` on an already running plan is idempotent too: no duplicate tickets or events.

Grill the human first on the frontier (scope, the shape of the deliverable, what "verified" means, hard constraints). Ask one concrete question at a time, stop at seven, and ask only what changes the tickets; facts are yours to look up.

**Done when:** every acceptance criterion of the campaign is claimed by at least one ticket, every ticket names its blockers and touched paths, the ticket graph is acyclic, and no ticket lacks a verifiable outcome. The campaign stage is `awaiting_approval`.

### 3. Bind and approve

Read the catalog for the campaign's adapter (`node scripts/orchestrate.mjs catalog --adapter <id>`) and confirm the chain for every kind the plan uses: a first model that matches the kind's work, a fallback from another family where one exists, and a thinking level. A new console already resolved the newest DeepSeek Flash, Muse Spark Contributor and MiMo Flash releases into the kinds (the reviewer stays on a different first model); `orchestrate defaults <campaign> --apply` fills empty chains against the live catalog. If a family is absent, bind by hand. The picker is cheapest first; the human still chooses.

If the draft is clean and `plan_gate: auto`, `plan import --submit` applies it and lets the supervisor approve. Otherwise, the human reviews the compact draft and makes one decision: **Approve and run** (`orchestrate approve <campaign>`), which applies the clean draft and dispatches.

The panel is a flight deck: it shows the plan, the tickets, the next action and the telemetry, and it configures the fleet. It never hosts the conversation. It has one manual **Tickets → New ticket** form for a single one-off slice; do not send the whole plan there. Approvals, answers and delivery reviews happen in this session, with a copyable command shown in the panel. The supervisor never invents tickets.

**Right-size the slices.** A ticket is an independently verifiable outcome, not a file, a layer, or a step. Start with **one ticket**. Split only when each slice is independently demoable and can proceed without a reasoning handoff; two or three are normal for a genuinely independent parallel effort. A fourth ticket triggers a budget warning, six or more asks for a written reason, and 16 is refused. Do not split by file, layer, or create “prepare”/“use it” pairs; merge them unless each is demoable alone. Every ticket costs a work run plus a review run and a fresh context reconstruction. See [references/protocol.md](references/protocol.md#context-and-the-plan) for the fragmentation and budget rules, and [docs/ADR-001-ticket-sizing-and-context.md](docs/ADR-001-ticket-sizing-and-context.md) for the decision.

**Tickets from chat.** The human does not need a form. Ask for the slice and make the contract explicit — **including the campaign**:

- One ticket: “Add a ticket to `<campaign>` for the CLI slice: kind code, blocked by 01, touches `src/cli/**`, what: add and list commands, acceptance: `add` prints added.”
- Several: “In `<campaign>`, split this context into tickets: storage first, then CLI on top, then docs. Show me the draft table before importing.”
- Whole plan: paste the context and say “In `<campaign>`, turn this into a plan; show me the draft, the deltas and your assumptions before importing.”

**Which campaign?** The conversation names it. If the project has exactly one campaign, the CLI infers it; if there are several and the human did not say which, run `orchestrate status`, list them, and ask once. Never guess. Pass `--campaign <slug>` explicitly on every plan write so the command is unambiguous.

For one ticket, run `orchestrate ticket add "<title>" --campaign <slug> --kind code --touches "src/cli/**" --blocked-by 01 --what "..." --accept "..."`. For a batch, write `plan.yml`, run `orchestrate plan draft`, present it, and import only after the human says “apply”. The panel form is the manual path for one slice, not a substitute for the plan.

Show the plan table, the chain table and the next action together. The human confirms once, in chat. A binding can change at any time while the campaign is not running; while it is, the supervisor refuses the change rather than let a live run's model be rewritten.

**Done when:** every kind in the plan has a chain, the human approves, the campaign stage is `running`, and the first frontier tickets are `queued`.

### 4. Supervise

Run the supervisor (`run`) or let a timer drive it (`tick`). From here the loop is mechanical: dispatch the frontier into free slots, collect **reports**, run **gates**, land what passes, and route what does not. Your job between ticks is the fleet and the queues: answer what a worker could not in the inbox, accept deliveries in the acceptance queue, watch provider quota windows, and re-cut tickets when the plan meets reality.

Answer questions with a decision, not with advice. A worker resumes from the answer in its own session, so it already knows what it asked — and the answer is written to the campaign's decision log, so the next worker on those paths inherits it instead of asking again.

A `ready` report carries one passed acceptance result for every ticket criterion, each with the evidence that proves it. A review pass is bound to the commit it judged; a branch that changes afterwards is parked for a fresh review. When every ticket is done, the campaign checks run once on the final integration tip, and delivery is a computed audit over that evidence. Failed acceptance, a stale review, or a failed integration check becomes one failure item, never a silent delivery.

**Done when:** every ticket is `done` or `dropped`, the integration checks pass at the delivered tip, the delivery audit has no blockers, and the campaign stage is `delivered`.

### 5. Close

Report what landed, what was dropped and why, what the spend was, and which tickets cost more than one attempt. If a class of failure repeated, propose a check that would have caught it.

When the campaign reaches `delivered`, name the branch and ask one delivery question: **open a PR from `orch/<slug>/integration` into `base`, or merge locally and clean up?** A local choice runs `review approve` and then `cleanup`; do not ask again. If the PR is chosen, `cleanup` waits until it lands. If the branch is already merged, ask the cleanup question once. `cleanup --dry-run` shows exactly what would go; removal is the default when the branch is safe, and the base checkout is never removed. The campaign stage is `archived` when closed.

**Done when:** the report is written and the panel shows no open inbox item or waiting delivery for the campaign.

## Commands

The script is the source of truth; the skill's slash commands are conveniences over it.

| Command | Does |
| --- | --- |
| `init` | Scaffold `orchestration/`, register the project in the console, write defaults |
| `start <goal>` | Create a `draft` campaign |
| `plan [campaign] [--json]` | Validate the plan and list every ticket |
| `plan draft <campaign> --file plan.yml [--verbose]` | Save a draft; print the table, deltas, coverage, assumptions, open questions and actionable warnings |
| `plan diff <campaign> [--verbose]` | Reprint the draft deltas without writing |
| `plan show <campaign> [--ticket <key>]` | Full draft ticket text; `--applied` shows the applied plan |
| `plan import <campaign> [--file plan.yml] [--prune] [--accept-open] [--accept-fragmented] [--submit]` | Apply the draft atomically; `--submit` runs a tick so an auto plan can approve |
| `plan discard <campaign>` | Abandon the draft without touching tickets |
| `plan audit <campaign> [--write]` | Show or persist the applied-plan audit; legacy campaigns derive it from the ticket graph |
| `context append <campaign> --from notes.md` | Append free-form human input to `context.md` |
| `ticket add "<title>" --kind code --touches "<globs>" [--attachments img.png] [--blocked-by 01] [--what ...] [--accept ...] [--covers ...]` | Add one ticket with the next number |
| `ticket edit <id> [--title ...] [--kind ...] [--touches ...] [--blocked-by ...] [--what ...] [--accept ...] [--covers ...] [--reason ...]` | Change a ticket; a change that would break the plan is rolled back, and the ledger records why |
| `ticket remove <id>` | Delete a ticket, refused while it still blocks another |
| `cancel [campaign]` | Stop every live run and pause, keeping the branches |
| `archive [campaign]` | Close a delivered campaign |
| `cleanup <campaign> [--dry-run]` | After the integration branch is merged, remove ticket/integration branches and the integration worktree; keep the base checkout |
| `approve <campaign>` | Apply a clean draft, then approve plan and bindings; one human decision |
| `bind <campaign> <kind> <model>[:thinking] [--fallback ...] [--adapter <id>]` | Set one kind's chain; refused while the campaign is running |
| `defaults [campaign] [--apply] [--force]` | Resolve the newest default family per kind from the live catalog; `--apply` fills empty chains, `--force` replaces |
| `up` | Start the supervisor and panel if they are not running, open the panel, print its URL |
| `down` | Stop the supervisor and panel |
| `run` | Supervisor: all registered campaigns, one tick loop, plus the panel |
| `tick` | One pass, no panel, safe for cron or a timer |
| `status [campaign]` | Campaigns, stages, slots, spend |
| `context [--ticket 03] [--packet]` | The substrate a worker reads: relevant decisions, siblings, diff, history; `--packet` emits a bounded handoff for a subagent |
| `decisions [campaign] [--all]` | List decisions with their ids |
| `promote <decision-id> [campaign]` | Share one decision with every campaign |
| `inbox` | Open questions and failures across all projects, oldest first |
| `acceptance` | Deliveries waiting for acceptance, oldest first |
| `answer <item> "..."` | Deliver a decision to the parked run |
| `review <item> approve\|reject "..."` | Accept landed work or send it back with findings |
| `deliver <campaign>` | Take a manual delivery now, without waiting for a new inbox item |
| `retry <ticket>` | New run on the next model in the chain |
| `stop <ticket>` | Kill the run, keep the branch |
| `pause\|resume <campaign>` | Stop and resume one campaign without touching live runs |
| `dispatch [status\|pause\|resume] [--reason "..."]` | The console-wide switch: stop every new claim, or resume |
| `quota list\|set\|remove ...` | Provider windows: `--window 5h --used 72 --limit 100 --reset <iso>` |
| `panel` | Print the panel URL |
| `link` | Put an `orchestrate` command in `~/.local/bin` |
| `desktop [remove]` | Add or remove a desktop menu launcher that runs `orchestrate up` |
| `catalog` | Print the catalog for an adapter: provider, model, context, thinking, images, price. `--adapter <id> [--refresh]` |
| `adapters` | List adapters, versions and catalog status |
| `doctor` | Check harness versions and catalog freshness; `--refresh` probes live auth/catalog |
| `adapter <id> [--spend mode]` | Set the console adapter and spend mode |

Every panel action has a CLI equivalent; the agent also has CLI-only verbs (answer, review, approve, plan draft, plan import, context append). Panel actions enqueue commands; the agent's plan verbs write committed plan files. The supervisor is the only writer of runtime state.

## Invariants

1. **One writer.** Only the supervisor mutates state. The panel and the CLI enqueue commands; they never edit files behind it.
2. **Structured reports.** A run ends by writing `report.json` through `scripts/report.mjs`. Prose never counts as a status, and "it probably needs a human" is never inferred from a summary. A `ready` report for a new run also carries one passed, evidenced acceptance result per ticket criterion; review findings are structured by severity and required fix.
3. **Push right.** A worker does the maximum before it asks. The orchestrator answers from written sources when it can, and cites the source. Anything else becomes one inbox item.
4. **One question per run.** A run that needs a person asks once, with the work it already did attached, so the human answers once, late, with everything prepared.
5. **A trace is checked, not trusted.** A `ready` report is accepted only if acceptance is evidenced, the supervisor's own checks pass, and the diff stays inside the paths the ticket declared. A worker's claim of "ready" is a request for review, not a result. A review pass is bound to the commit it judged, and the final integration tip gets one more check before delivery.
6. **Memory is written by the supervisor alone.** Workers read decisions; answers become decisions; promotion to the console log is deliberate. The one thing worth more than a fast answer is an answer that never has to be given twice.
7. **A plan is drafted before it is applied.** `plan draft` writes only the draft; `tickets/` is untouched until `plan import` or `approve`. `approve` applies a clean draft and approves it in one decision; an unclean draft writes nothing. The supervisor never invents or edits tickets.

## Layout

```
orchestration/                 # committed: the plan and its history
  <campaign>/
    campaign.md                # goal, brief, criteria, assumptions, questions, constraints, reading, config
    context.md                 # raw human input, timestamped, append-only
    tickets/01-slug.md         # vertical slices, blockers, touched paths, sources
.orchestration/                # gitignored: machine state
  events.jsonl                 # append-only ledger; the panel streams it
  <campaign>/
    state.json                 # stages, slots, spend, binding snapshot
    plan.yml                   # current draft; plan.prev.yml keeps the last revision
    plan.applied.yml           # last applied plan; plan.applied.json is its audit
    runs/<run-id>/             # prompt.md, run.json, log.jsonl, report.json
    sessions/                  # worker sessions, resumed by ticket
    worktrees/<ticket>/        # checkout while the ticket runs; removed when done, branch kept
    inbox/<item>.json
```

The console lives outside any project: `~/.config/orchestration/console.json` for defaults, `~/.local/state/orchestration/registry.json` for the projects the panel serves.

## Run it without the path

Once per machine:

```bash
node scripts/orchestrate.mjs link      # writes ~/.local/bin/orchestrate
node scripts/orchestrate.mjs desktop   # optional: a menu entry that runs `orchestrate up`
```

Then, from any project, `orchestrate up` starts the panel if it is not running, opens it in the browser, and prints the URL. `orchestrate down` stops it, and `orchestrate status` works the same way. `up` reuses a supervisor that is already serving, because one supervisor serves every registered project.

## Dependencies

Node 20 or newer, `git`, and either the `pi` CLI or an ACP harness such as `agy` (Antigravity) or `opencode`. No `npm install`, no lockfile, no `node_modules`; the runtime uses the Node standard library only. State is written to the user's project and to the console directory, never inside this skill folder. On Linux, `bwrap` is optional and enables the OS-level worker sandbox (`runner.sandbox: auto`). ImageMagick is optional and enables downscaling large images.

The adapter catalog lives in `~/.local/state/orchestration/catalogs/<adapter>.json`. `bind` and `approve` refresh it from the harness; the panel reads the snapshot. If discovery fails, the campaign cannot leave `awaiting_approval`; fix the harness's credentials and run `orchestrate catalog --adapter <id> --refresh`. `init` seeds a new console from the default ladders; reading the catalog and confirming a chain per kind is step 3 of the loop.
