---
name: orchestration
description: Plan a complex, multi-ticket campaign, bind a model to each ticket kind, dispatch parallel worker agents under slots and worktrees, park real questions in one inbox, and land verified work. Ships a local panel that shows the campaign live.
disable-model-invocation: true
---

# Orchestration

A **campaign** turns one paragraph of intent into landed work. You plan it as **tickets** with blocking edges, approve the model binding for each **ticket kind**, then a supervisor dispatches **runs** in parallel, up to its **slots**. Work that needs a person stops at the **inbox**; work that passes its **gates** lands.

The supervisor is a zero-dependency Node process (`scripts/orchestrate.mjs`) plus a local panel. Read the reference for a branch before acting on it:

- [references/config.md](references/config.md): campaign form, ticket kinds, model chains, budget, inheritance, validation.
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

Fill the campaign form: brief, acceptance criteria, constraints, and the reading list (files, material, links) that a worker should read before touching anything. Then slice the work into **tickets**: each a vertical slice, each sized to one fresh context window, each declaring the tickets that **block** it and the paths it **touches**.

Grill the human first, one capped round of at most seven questions on the frontier (scope, the shape of the deliverable, what "verified" means, hard constraints). Ask only what changes the tickets; facts are yours to look up.

**Done when:** every acceptance criterion of the campaign is claimed by at least one ticket, every ticket names its blockers and touched paths, the ticket graph is acyclic, and no ticket lacks a verifiable outcome. The campaign stage is `awaiting_approval`.

### 3. Bind and approve

Read the catalog for the campaign's adapter (`node scripts/orchestrate.mjs catalog --adapter <id>`) and propose a chain for every kind the plan uses: a first model that matches the kind's work, a fallback from another provider where one exists, and a thinking level. One line of reasoning per kind, so the human can disagree with the choice rather than re-derive it. Nothing is pre-bound and no vendor name ships with this skill, so this step is never empty. The picker is ordered cheapest first; the human still chooses.

Show the plan and the table together. The human confirms once, in chat or in the panel. A binding can change at any time while the campaign is not running; while it is, the supervisor refuses the change rather than let a live run's model be rewritten.

**Done when:** every kind in the plan has a chain, the human approves, the campaign stage is `running`, and the first frontier tickets are `queued`.

### 4. Supervise

Run the supervisor (`run`) or let a timer drive it (`tick`). From here the loop is mechanical: dispatch the frontier into free slots, collect **reports**, run **gates**, land what passes, and route what does not. Your job between ticks is the inbox: answer what a worker could not, approve what a gate could not, and re-cut tickets when the plan meets reality.

Answer questions with a decision, not with advice. A worker resumes from the answer in its own session, so it already knows what it asked — and the answer is written to the campaign's decision log, so the next worker on those paths inherits it instead of asking again.

**Done when:** every ticket is `done` or `dropped`, the integration result is delivered, and the campaign stage is `delivered`.

### 5. Close

Report what landed, what was dropped and why, what the spend was, and which tickets cost more than one attempt. If a class of failure repeated, propose a check that would have caught it. The campaign stage is `archived`.

**Done when:** the report is written and the panel shows no open inbox item for the campaign.

## Commands

The script is the source of truth; the skill's slash commands are conveniences over it.

| Command | Does |
| --- | --- |
| `init` | Scaffold `orchestration/`, register the project in the console, write defaults |
| `start <goal>` | Create a `draft` campaign |
| `plan [campaign]` | Validate the plan and list every ticket |
| `ticket add "<title>" --kind code --touches "<globs>" [--attachments img.png] [--blocked-by 01] [--what ...] [--accept ...]` | Add one ticket with the next number |
| `ticket edit <id> [--title ...] [--kind ...] [--touches ...] [--blocked-by ...] [--what ...] [--accept ...]` | Change a ticket; a change that would break the plan is rolled back |
| `ticket remove <id>` | Delete a ticket, refused while it still blocks another |
| `cancel [campaign]` | Stop every live run and pause, keeping the branches |
| `archive [campaign]` | Close a delivered campaign |
| `approve <campaign>` | Approve plan and bindings; allow dispatch |
| `bind <campaign> <kind> <model>[:thinking] [--fallback ...] [--adapter <id>]` | Set one kind's chain; refused while the campaign is running |
| `up` | Start the supervisor and panel if they are not running, open the panel, print its URL |
| `down` | Stop the supervisor and panel |
| `run` | Supervisor: all registered campaigns, one tick loop, plus the panel |
| `tick` | One pass, no panel, safe for cron or a timer |
| `status [campaign]` | Campaigns, stages, slots, spend |
| `context [--ticket 03]` | The substrate a worker reads: relevant decisions, siblings, diff, history |
| `decisions [campaign] [--all]` | List decisions with their ids |
| `promote <decision-id> [campaign]` | Share one decision with every campaign |
| `inbox` | Open items across all projects, oldest first |
| `answer <item> "..."` | Deliver a decision to the parked run |
| `review <item> approve\|reject "..."` | Accept landed work or send it back with findings |
| `deliver <campaign>` | Take a manual delivery now, without waiting for a new inbox item |
| `retry <ticket>` | New run on the next model in the chain |
| `stop <ticket>` | Kill the run, keep the branch |
| `pause\|resume <campaign>` | Stop and resume dispatch without touching live runs |
| `panel` | Print the panel URL |
| `link` | Put an `orchestrate` command in `~/.local/bin` |
| `desktop [remove]` | Add or remove a desktop menu launcher that runs `orchestrate up` |
| `catalog` | Print the catalog for an adapter: provider, model, context, thinking, images, price. `--adapter <id> [--refresh]` |
| `adapters` | List adapters, versions and catalog status |
| `doctor` | Check harness versions and catalog freshness; `--refresh` probes live auth/catalog |
| `adapter <id> [--spend mode]` | Set the console adapter and spend mode |

Every panel action has a CLI equivalent and vice versa; both write the same command queue, and the supervisor is the only writer of state.

## Invariants

1. **One writer.** Only the supervisor mutates state. The panel and the CLI enqueue commands; they never edit files behind it.
2. **Structured reports.** A run ends by writing `report.json` through `scripts/report.mjs`. Prose never counts as a status, and "it probably needs a human" is never inferred from a summary.
3. **Push right.** A worker does the maximum before it asks. The orchestrator answers from written sources when it can, and cites the source. Anything else becomes one inbox item.
4. **One question per run.** A run that needs a person asks once, with the work it already did attached, so the human answers once, late, with everything prepared.
5. **A trace is checked, not trusted.** A `ready` report is accepted only if the supervisor's own checks pass and the diff stays inside the paths the ticket declared. A worker's claim of "ready" is a request for review, not a result.
6. **Memory is written by the supervisor alone.** Workers read decisions; answers become decisions; promotion to the console log is deliberate. The one thing worth more than a fast answer is an answer that never has to be given twice.

## Layout

```
orchestration/                 # committed: the plan and its history
  <campaign>/
    campaign.md                # goal, brief, criteria, constraints, reading list, config
    tickets/01-slug.md         # vertical slices, blockers, touched paths
.orchestration/                # gitignored: machine state
  events.jsonl                 # append-only ledger; the panel streams it
  <campaign>/
    state.json                 # stages, slots, spend, binding snapshot
    runs/<run-id>/             # prompt.md, run.json, log.jsonl, report.json
    sessions/                  # worker sessions, resumed by ticket
    worktrees/<ticket>/        # isolation for branch-landing campaigns
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

Node 20 or newer, `git`, and either the `pi` CLI or an ACP harness such as `agy` (Antigravity) or `opencode`. No `npm install`, no lockfile, no `node_modules`; the runtime uses the Node standard library only. State is written to the user's project and to the console directory, never inside this skill folder.

The adapter catalog lives in `~/.local/state/orchestration/catalogs/<adapter>.json`. `bind` and `approve` refresh it from the harness; the panel reads the snapshot. If discovery fails, the campaign cannot leave `awaiting_approval`; fix the harness's credentials and run `orchestrate catalog --adapter <id> --refresh`. `init` binds nothing: reading the catalog and choosing a chain per kind is step 3 of the loop.
