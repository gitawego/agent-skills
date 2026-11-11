---
name: orchestration
description: Plan a complex, multi-ticket campaign, bind a model to each ticket kind, dispatch parallel worker agents under slots, quotas and worktrees, park real questions in one inbox, accept deliveries in one queue, and land verified work. Ships a local fleet panel that shows every campaign live.
disable-model-invocation: true
---

# Orchestration

A **campaign** turns one paragraph of intent into landed work. You plan it as **tickets** with blocking edges, approve the model binding for each **ticket kind**, then a supervisor dispatches **runs** in parallel, up to its **slots** and provider quota windows. Questions stop at the **inbox**; finished deliveries wait in **acceptance**; work that passes its **gates** lands.

The supervisor is a zero-dependency Node process (`scripts/orchestrate.mjs`) plus a local panel. Read the reference for a branch before acting on it:

- [references/config.md](references/config.md): campaign document, ticket kinds, model chains, budget, inheritance, validation.
- [references/protocol.md](references/protocol.md): stages, ticket files, report schema, slots, retries, gates, landing, events.
- [references/contract.md](references/contract.md): the standing rules appended to every worker's system prompt.
- [references/roles/](references/roles/): one contract per kind — code, design, visual, research, plan, chores, review, judge, merge.
- [references/panel.md](references/panel.md): screens, actions, HTTP and SSE surface.
- [references/memory.md](references/memory.md): decisions, supersession, promotion, the context command, the close report.
- [references/worker-prompt.md](references/worker-prompt.md): what a worker is told.

## When to use it

Use it when the work is larger than one context window and can be split into slices that are each verifiable on their own: a feature spanning schema, API, UI, and tests; a migration; a design or research effort with several deliverables.

Reach for it only when the campaign will run more than one ticket. One ticket is `/implement`. An idea still too foggy to slice is `/wayfinder`. Work whose only output is a decision is `/grilling`.

## The loop

Five steps. Each has a completion criterion; do not start the next until it holds.

### 1. Start

The human invokes `/orchestration start <goal>`. Scaffold if this project has no campaign yet (`node scripts/orchestrate.mjs init`), then create a `draft` campaign holding the goal.

**Done when:** `orchestration/<campaign>/campaign.md` exists with a one-sentence goal, and the campaign stage is `draft`.

### 2. Plan

Take the human's free-form context — notes, links, constraints, prior attempts, screenshots — and persist it with `orchestrate context append <campaign> --from notes.md`. It lands in `orchestration/<campaign>/context.md` as raw, timestamped input; the brief is your synthesis, the context is the source.

Then write a **draft** plan: goal, brief, acceptance criteria, constraints, assumptions, open questions, reading list, and the **tickets**. Each ticket is a vertical slice, sized to one fresh context window, declaring the tickets that **block** it, the paths it **touches**, and the **sources** it came from.

Save the draft with `orchestrate plan draft <campaign> --file plan.yml`; `--file` is the new revision to read and may be a scratch file. The canonical draft is written to `.orchestration/campaigns/<campaign>/plan.yml`, and the previous revision is kept as `plan.prev.yml`. It validates the plan, snapshots the previous draft, and prints the table, the delta **since your last draft**, the delta **apply will change**, assumptions, open questions and warnings. Show that in chat. The human can keep talking: “split 02”, “block 03 on 01”, “drop docs”. Each revision is another `plan draft`; present the delta, not a fresh table. Nothing is written to `tickets/` until the human says “apply”.

`orchestrate plan import <campaign>` applies the current draft. It stops before approval, refuses while anything is running, requires `assumptions`, and blocks on open questions unless `--accept-open` is passed. Re-import is idempotent by ticket `key`. `approve` refuses while a draft is unapplied; apply or `plan discard` first.

Grill the human first, one capped round of at most seven questions on the frontier (scope, the shape of the deliverable, what "verified" means, hard constraints). Ask only what changes the tickets; facts are yours to look up.

**Done when:** every acceptance criterion of the campaign is claimed by at least one ticket, every ticket names its blockers and touched paths, the ticket graph is acyclic, and no ticket lacks a verifiable outcome. The campaign stage is `awaiting_approval`.

### 3. Bind and approve

Read the catalog for the campaign's adapter (`node scripts/orchestrate.mjs catalog --adapter <id>`) and confirm the chain for every kind the plan uses: a first model that matches the kind's work, a fallback from another family where one exists, and a thinking level. A new console already resolved the newest DeepSeek Flash, Muse Spark Contributor and MiMo Flash releases into the kinds (the reviewer stays on a different first model); `orchestrate defaults <campaign> --apply` fills empty chains against the live catalog. Confirm, adjust, and say why in one line per kind, so the human can disagree with the choice rather than re-derive it. If a family is absent from the adapter's catalog, that chain is still empty and must be bound by hand. The picker is ordered cheapest first; the human still chooses.

The panel is a flight deck: it shows the plan, the tickets, the next action and the telemetry, and it configures the fleet. It never hosts the conversation. It has one manual **Tickets → New ticket** form for a single one-off slice; do not send the whole plan there. Approvals, answers and delivery reviews happen in this session, with a copyable command shown in the panel. The supervisor never invents tickets.

**Right-size the slices.** A ticket is an independently verifiable outcome, not a file or a step. Aim for 3–7 tickets; 8+ needs a reason and 16 is refused. Do not split by file, and do not create a “prepare” ticket followed by a “use it” ticket: merge them unless each is demoable alone. Group docs/chores with the change they describe. A ticket with one touched path and one acceptance criterion is a small slice; four or more small slices making up at least half the plan block `plan import` unless you pass `--accept-fragmented`. Every ticket costs a work run plus a review run, so 6 tickets is at least 12 model runs before retries.

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

**Done when:** every ticket is `done` or `dropped`, the integration result is delivered, and the campaign stage is `delivered`.

### 5. Close

Report what landed, what was dropped and why, what the spend was, and which tickets cost more than one attempt. If a class of failure repeated, propose a check that would have caught it.

When the campaign reaches `delivered`, name the integration branch and ask the human one clear question: **open a PR from that branch into `base`, or merge locally?** After it is in `base`, ask a second: **remove the campaign branches and integration worktree?** `orchestrate cleanup <campaign> --dry-run` shows exactly what would go; cleanup keeps the base checkout. Do not remove the worktree or branches before that answer. The campaign stage is `archived` when closed.

**Done when:** the report is written and the panel shows no open inbox item or waiting delivery for the campaign.

## Commands

The script is the source of truth; the skill's slash commands are conveniences over it.

| Command | Does |
| --- | --- |
| `init` | Scaffold `orchestration/`, register the project in the console, write defaults |
| `start <goal>` | Create a `draft` campaign |
| `plan [campaign] [--json]` | Validate the plan and list every ticket |
| `plan draft <campaign> --file plan.yml` | Save a draft; print the table, deltas, assumptions, open questions and warnings |
| `plan diff <campaign>` | Reprint the draft deltas without writing |
| `plan show <campaign> [--ticket <key>]` | Full draft ticket text; `--applied` shows the applied plan |
| `plan import <campaign> [--file plan.yml] [--prune] [--accept-open] [--accept-fragmented]` | Apply the draft atomically; refuses while running; stops before approval |
| `plan discard <campaign>` | Abandon the draft without touching tickets |
| `plan audit <campaign> [--write]` | Show or persist the applied-plan audit; legacy campaigns derive it from the ticket graph |
| `context append <campaign> --from notes.md` | Append free-form human input to `context.md` |
| `ticket add "<title>" --kind code --touches "<globs>" [--attachments img.png] [--blocked-by 01] [--what ...] [--accept ...]` | Add one ticket with the next number |
| `ticket edit <id> [--title ...] [--kind ...] [--touches ...] [--blocked-by ...] [--what ...] [--accept ...]` | Change a ticket; a change that would break the plan is rolled back |
| `ticket remove <id>` | Delete a ticket, refused while it still blocks another |
| `cancel [campaign]` | Stop every live run and pause, keeping the branches |
| `archive [campaign]` | Close a delivered campaign |
| `cleanup <campaign> [--dry-run]` | After the integration branch is merged, remove ticket/integration branches and the integration worktree; keep the base checkout |
| `approve <campaign>` | Approve plan and bindings; allow dispatch |
| `bind <campaign> <kind> <model>[:thinking] [--fallback ...] [--adapter <id>]` | Set one kind's chain; refused while the campaign is running |
| `defaults [campaign] [--apply] [--force]` | Resolve the newest default family per kind from the live catalog; `--apply` fills empty chains, `--force` replaces |
| `up` | Start the supervisor and panel if they are not running, open the panel, print its URL |
| `down` | Stop the supervisor and panel |
| `run` | Supervisor: all registered campaigns, one tick loop, plus the panel |
| `tick` | One pass, no panel, safe for cron or a timer |
| `status [campaign]` | Campaigns, stages, slots, spend |
| `context [--ticket 03]` | The substrate a worker reads: relevant decisions, siblings, diff, history |
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
2. **Structured reports.** A run ends by writing `report.json` through `scripts/report.mjs`. Prose never counts as a status, and "it probably needs a human" is never inferred from a summary.
3. **Push right.** A worker does the maximum before it asks. The orchestrator answers from written sources when it can, and cites the source. Anything else becomes one inbox item.
4. **One question per run.** A run that needs a person asks once, with the work it already did attached, so the human answers once, late, with everything prepared.
5. **A trace is checked, not trusted.** A `ready` report is accepted only if the supervisor's own checks pass and the diff stays inside the paths the ticket declared. A worker's claim of "ready" is a request for review, not a result.
6. **Memory is written by the supervisor alone.** Workers read decisions; answers become decisions; promotion to the console log is deliberate. The one thing worth more than a fast answer is an answer that never has to be given twice.
7. **A plan is drafted before it is applied.** `plan draft` writes only the draft; `tickets/` is untouched until `plan import`. Approval refuses while a draft is unapplied. The supervisor never invents or edits tickets.

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
