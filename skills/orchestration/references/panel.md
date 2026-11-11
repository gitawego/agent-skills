# Panel

A local web page served by the supervisor. It is a **flight deck**: the agent flies, the panel shows instruments and switches. It answers four questions in this order: **what is happening across every project**, **does anything need me now**, **is the system healthy and doing the right thing**, and **what happened to this one piece of work**.

The seam is deliberate. The panel **monitors and configures**, and keeps one manual **New ticket** form for a single one-off slice. The agent tool **converses, plans, approves, answers and reviews**, and is the primary way to turn context into a ticket graph. A decision that needs a sentence happens in the agent; a glance or a switch happens here. The panel never hosts a chat and never calls a model.

One supervisor serves every registered project. One page, one event stream, no per-project switching.

## Shape

```
┌───────────────┬──────────────────────────────────────────────────────────┐
│ orchestration │ fleet  inbox 1  acceptance 2  settings   dispatch auto ● │
│               │                                                          │
├───────────────┼──────────────────────────────────────────────────────────┤
│ CAMPAIGNS     │  astral-plasma / quick-shell-theme        draft          │
│ All campaigns │  Make a perfect quick shell theme                        │
│ habitlog  ↗   │  NEXT  You · write the plan in your agent                │
│ 5 tickets     │        orchestrate plan draft …                   [copy]  │
│ quick-shell   │  [ Overview ] [ Tickets 5 ] [ Configure ] [ History ]    │
│ start in agent│                                                          │
│ open repo…    │  Brief · Acceptance · Context · Constraints · Reading    │
└───────────────┴──────────────────────────────────────────────────────────┘
```

Three regions pin themselves while their middle scrolls: the top bar (crumbs, global views, dispatch switch, live state); the rail's wordmark and foot, with the campaign list scrolling between them; and the drawer's head and foot, with only the ticket body scrolling.

A **strip** is one ticket: a perforated number stub, the title, the kind, and telemetry. A **band** is one stage. The **ledger** is the campaign's real history, newest first.

## Screens

| Screen | Shows | Acts |
| --- | --- | --- |
| **Fleet** (default) | One row per ticket across every project plus one row per delivery waiting for acceptance; status tabs, search, project and adapter filters, quota windows, and the queue reason on every row | Open a ticket or a delivery, pause/resume dispatch, filter, **Open campaign** |
| **Inbox** | Every open question and failure across projects, oldest first, with the question, options, default, what the worker tried and a copyable answer command | Copy the command, open the ticket, open the campaign. No textarea, no answer button |
| **Acceptance** | Open delivery reviews grouped by campaign, with the changed-line count, autoship limit, checks and findings, plus copyable approve and send-back commands | **Approve, merge and clean up** as a binary action, copy the send-back command, open the campaign |
| **Campaign → Overview** | The read-only briefing (goal as the title, brief, criteria, context, constraints, reading), health counts, the next-action rail and the recent ledger | Read; copy the next command; open another section; pause/resume/cancel/archive |
| **Campaign → Tickets** | The ticket manifest: list or board, stage counts, kind filter, search, blocked-by chips, coverage chips, the ticket drawer, and a collapsible **New ticket** form | Open a ticket; stop or retry from the drawer; add one ticket by hand; copy the agent prompt for batches |
| **Campaign → Configure** | Delivery policy, runtime (adapter, spend, sandbox, budget, autoship), checks, generated paths, quotas, and the model chains | Edit, save once, use defaults, refresh models; pause first for chain changes |
| **Campaign → History** | Spend by model, cache-hit rate, the full ledger, decisions and the delivery record | Read; copy the promote/close commands |
| **Settings** | Console limits, the runner adapter/spend/sandbox, provider quota windows, and the ticket kinds with their chains | Edit and save, discover or refresh adapter models |
| **Drawer** | One ticket in a pinned head and foot: what to build, criteria, sources, a collapsed **Evidence** section (acceptance results, findings by severity, review/worker models, reviewed SHA, gate cycles, integration state), the last answer, telemetry, its runs and the streaming log | Stop while it runs, retry when it failed or was sent back, copy the edit/answer command. No edit form |

Views have addresses: `#fleet?status=acceptance&project=habitlog&adapter=agy-acp&q=seed`, `#inbox`, `#acceptance`, `#settings`, `#campaign/<slug>` for Overview, `#campaign/<slug>/tickets|configure|history` for the sections, and `#ticket/03` for the drawer. Old `#board` links land on the selected campaign's ticket board. Fleet filters are client-side up to 1,000 rows; the table renders 200 at a time with **Load more**.

## The next-action rail

Under every campaign title is one line that names the actor and, when the actor is you, the exact command:

| State | Actor | Line |
| --- | --- | --- |
| Draft, no tickets, no draft | You | Write the plan in your agent session |
| Draft or paused, clean draft exists | You | **Approve and run** — applies the draft and dispatches; no separate import |
| Draft, draft has an open question or blocking warning | You | Read the reason and copy `plan diff`; no approve action |
| Draft, tickets, unbound chains | You | Bind the model chains |
| Draft or awaiting approval | You | Approve the plan and bindings |
| Running, quiet | Supervisor | Dispatching the frontier |
| Running, question | Worker | Ticket 03 is waiting for a decision |
| Running, delivery | You | A delivery is waiting for review |
| Paused | You | Paused: resume or re-plan |
| Delivered, manual | You | Review the delivery; branch `orch/<slug>/integration` → base; open a PR or merge locally |
| Delivered, merged | You | Remove the integration worktree and campaign branches? |
| Archived | Nobody | The record is closed |

The line is derived in `campaignView` from state, inbox and deliveries; it is deterministic and costs no tokens. The rail row repeats the `you` marker so a fleet of campaigns shows where a person is needed.

## The campaign workspace

**Overview is read-only, and quiet by default.** The goal is the H1; the slug and project are a mono eyebrow. The next-action rail, stage, ticket counts, spend and cache come first. The briefing is collapsed behind **Briefing**; a draft adds the **Draft plan · not applied** block and a collapsed **Draft briefing**. `Context` is a collapsible raw-input block. A note says the text is written by the agent; edits happen in the agent session. The applied campaign document is not overwritten until `plan import`. There is no draft editor and no full document on first paint.

**Tickets has its own screen.** The applied list shows #, title, kind, stage, model, cost and blockers; the board uses the same stage bands and strips as the Fleet. A ticket opens in the drawer. If a draft exists, a read-only **Draft tickets · not applied** table (key, title, kind, blockers) sits above the applied list; it is a preview, not a set of files. A collapsible **New ticket** form covers a single one-off addition: title, kind, blockers, touches, files, what to build, and acceptance. The empty state shows the exact sentence to give the agent and the `orchestrate ticket add` / `plan draft` commands. A filter narrows by kind, stage or text without a round-trip.

**Configure owns every editable field.** Delivery policy, runtime, chains, and one **Advanced** disclosure for sandbox, budget, autoship, checks, generated paths and quotas. A sticky **Save configuration** bar is the only write. Changing chains or the adapter is refused while the campaign runs; the panel says so. Plan text is not editable here.

**History is the audit.** The applied plan (hash, time, ticket count, assumptions and accepted open questions), any pending draft, **Attention** (approvals, questions answered, deliveries reviewed, cleanups, total human actions), spend by model, cached-read share, the last 40 ledger events, decisions with their scope and citation, and the delivery record. The delivery block names the integration branch and its base: a manual delivery shows **open a PR** / **push the branch** commands and says a local merge also removes the worktree and branches in the same decision; a merged delivery shows **preview cleanup** and **remove branches and worktree**. The base checkout is never removed. Campaigns that predate `plan.applied.json` derive the audit from their ticket graph and are labelled **derived from tickets**. Sharing a decision or closing the campaign is a copyable agent command.

## Starting and planning

The panel does not create campaigns or tickets. The empty Fleet says:

```
No campaigns yet.
A campaign starts in your agent session: one goal, free-form context, and a ticket graph the agent imports.
Start a campaign   orchestrate start "<goal>"   [copy]
```

The rail carries the same **Start in your agent** handoff. For a single extra ticket in an existing campaign, use **Tickets → New ticket** or say to the agent: “Add a ticket to `<campaign>` for the CLI slice: kind code, touches src/cli/**, blocked by 01, acceptance: add prints added.” For several tickets, say “In `<campaign>`, split this context into tickets and show me the table before importing.” The conversation names the campaign; if the project has several and the human did not, the agent lists them and asks once rather than guessing. **Open another repository** stays: browse folders, then **Open this folder**. The server validates the directory, adds it to the live project list and the console registry, so its campaigns appear immediately and on the next start. `GET /api/browse?path=` lists subdirectories; no string path is required in the UI. This is registration, not authoring.

The agent flow is:

1. `orchestrate start "<goal>"` creates the campaign.
2. The human gives free-form context in chat. The agent persists it with `orchestrate context append <campaign> --from notes.md`; it lands in `orchestration/<campaign>/context.md` as timestamped raw input.
3. The agent writes a draft and runs `orchestrate plan draft <campaign> --file plan.yml`. The command validates it, snapshots the previous draft, and prints the table, both deltas, coverage, assumptions, open questions and warnings. The agent presents that in chat; the panel shows the same draft, its coverage matrix, and one **Approve and run** action when it is clean.
4. The human fine-tunes in chat (“split 02”, “drop docs”, “block 03 on 01”). Each revision is another `plan draft`; the agent presents only the delta. `tickets/` is untouched until the human says “apply”.
5. The human makes one decision: **Approve and run**. `orchestrate approve <campaign>` applies the clean draft atomically, records `plan.applied.yml` and the audit, then approves and dispatches. An open question, error, blocking fragmentation, or failed binding preflight refuses and writes nothing. `plan import` remains available as apply-only for explicit and auto workflows. Re-import is idempotent by ticket `key`; `--prune` removes missing keyed tickets only when they have no runs.
6. The agent proposes the chains (`orchestrate defaults <campaign> --apply`, then `bind` for exceptions) before that single approval.
7. The supervisor dispatches; the panel watches. The human answers and reviews in the agent.

The supervisor never invents tickets. Planning is an agent act, accepted by a human; execution is deterministic.

## Configuration

**Chains are picked, never typed.** Each kind shows its models as chips (`adapter · provider/model` and thinking level), with a searchable picker listing every adapter's catalog — provider, model, context window, whether it reads images, and the price per 1M tokens when the adapter knows it. **Use defaults** on Settings or Campaign → Configure resolves the newest stable DeepSeek Flash, Muse Spark Contributor and MiMo Flash releases into the empty chains and leaves any chain a person already bound. For OpenCode, defaults stay on `opencode-go`; the reseller rows are never a default.

Options are grouped by adapter and sorted by a blended list price (input weighted 4:1 over output), free first and unknown last; for code, design, visual and review, free/promo models are hidden by default. Subscription-only hides models outside the plan, and the adapter selector sets the default for new entries. The panel refuses a save that binds a model from the wrong catalog. The first chip starts the ticket; each one after it is a fallback. Removing a chip removes that entry; adding one appends.

Quotas are configuration. Delivery policy and runtime are configuration. Pausing, resuming, cancelling, stopping, retrying, delivering and archiving are operational switches; they stay in the panel because they do not need a sentence.

## Dispatch switch

The top bar holds one console-wide switch: **Dispatch auto** or **Dispatch paused: reason**. Pausing asks for a short reason, written to `~/.local/state/orchestration/dispatch.json` and repeated on every queued Fleet row. It never touches live runs; it only stops the next claim. Resuming is one click and clears the reason.

```
orchestrate dispatch status
orchestrate dispatch pause --reason "quota exhausted"
orchestrate dispatch resume
```

A campaign's own **Pause** is separate: it stops that campaign and still lets its live runs finish.

## Provider quota windows

The Fleet header shows every console quota window: provider, window, a bar, percent used, reset countdown, source and **stale** when the observation is old. A campaign can add windows or override a console window by provider/adapter/window; Campaign → Configure shows the resolved set.

The scheduler refuses to start a model whose matching window is exhausted, and the Fleet row says which window and when it resets. It tries the next entry in the chain first, so one exhausted plan does not park a ticket that has a free fallback. Stale data is displayed but never enforced: a forgotten manual entry must not freeze the fleet. A reset time in the past clears the window.

`orchestrate quota list`, `quota set` and `quota remove` write the same console entries.

## Inbox and Acceptance

Both are **handoff queues**, not chat. The card carries the evidence and the command; the decision happens in the agent session.

- **Inbox** shows questions and failures. `Answer in your agent: orchestrate answer <id> "…"`. A failure offers `orchestrate retry <ticket>` when there is a ticket.
- **Acceptance** shows deliveries with the diff size, the autoship rule, checks and findings. `Approve in your agent: orchestrate review <id> approve "…"`; `Send back… reject "…"`.

The queue clears on the next supervisor tick after the agent runs the command. The server still accepts the old answer/review commands from the CLI; the panel no longer exposes an input for them.

## Telemetry

The drawer and History label what they know. **Actual** means the provider reported the dollars, **estimated** means tokens multiplied by the current price table, and **included** means a subscription run with an API-equivalent value that was never billed. A missing price says `cost unknown`, never `$0.00`.

The same block shows context used against the model's window (when the catalog knows it), cached-read share, and output tokens per second. Runs record adapter, adapter version and host so a later catalog or machine change cannot rewrite what produced a report. When a harness reports subagents or child runs, they appear under **Child runs** with their own model, status, tokens and dollars. They are observation only: the scheduler never turns them into tickets.

## Rules

1. **Switches stay, sentences move.** Answers and nuanced review happen in the agent. Binary approvals — approve a clean plan, approve and merge a delivery — are one click because the evidence is already on the screen. The clean-plan click applies the draft and dispatches; it is the same one decision as `orchestrate approve`. The panel never hosts a textarea for a decision, and keeps one manual New ticket form for a single slice.
2. **What needs a person comes first.** An empty inbox says so in one line; a healthy campaign takes one band.
3. **One place per concept.** Fleet is the map, Inbox is the question queue, Acceptance is the delivery queue, Tickets is one campaign's manifest, Configure is the only form, History is the audit.
4. **A draft is not a ticket.** `plan draft` writes only `.orchestration/campaigns/<slug>/plan.yml`; the Tickets tab shows a read-only draft preview. `plan import` writes `tickets/`; `approve` writes them too when it applies a clean draft, then approves in the same action. Counts are lengths; a draft count never claims applied work.
5. **Honest state.** Spend is measured and labelled actual, estimated or included. A stale quota is drawn as stale. The live dot turns hollow when the stream drops.
6. **The page never writes plan files directly.** It enqueues commands, including the manual `ticket.add`; the supervisor applies them. The agent writes `context.md`, the plan and batches of tickets.
7. **Local only.** The server binds `127.0.0.1` and refuses non-loopback callers. The token lives in `~/.local/state/orchestration/token` (mode 0600) and does not rotate between restarts. Opening the panel once with `?token=` sets an HttpOnly cookie for the origin, so a refresh, a new tab or a bookmark needs no token; the address bar is cleaned on load so the token does not sit in history.

## Transport

- `orchestrate up` is the ordinary way in: it starts the supervisor if needed, opens the panel, and prints the URL. The panel writes its address, port, token and pid to `~/.local/state/orchestration/panel.json`, which is how `up` and `down` find a running one, and how `orchestrate panel` answers from any project.

**`GET /api/state`** returns the derived view: projects, campaigns, next actions, context, counts, tickets, inbox, spend and cache by model, effective chains, quota windows, the console dispatch state, and the last events. The page renders from this and never parses files.
- **`GET /api/events`** is `text/event-stream`. Each message carries the ledger event and its sequence id; on connect the stream replays what it still holds after `lastId`. The page refetches `/api/state` on each event, coalesced.
- **`GET /api/log?project=&campaign=&run=&offset=`** returns the next bytes of a run log with the new offset, so the drawer keeps streaming across reconnects.
- **`POST /api/commands`** takes `{ root, type, ... }` and returns the queued command. The supervisor picks it up within one tick (2 s by default).
- **`POST /api/projects`** takes `{ root }`, validates the directory, adds it to the live project list and the console registry.
- **`GET /api/browse?path=`** lists subdirectories for the folder picker; omit `path` for the home directory.
- **`POST /api/attachments`** takes `{ root, campaign, name, data }` (base64 image or PDF) and writes it under `orchestration/<campaign>/attachments/`, returning the project-relative path. The manual **New ticket** form uses this endpoint for attachments; the agent can also write them and reference them from `plan draft`/`plan import`.

Commands the panel sends: `pause`, `resume`, `cancel`, `dispatch.pause`, `dispatch.resume`, `deliver`, `archive`, `retry`, `stop`, `campaign.save`, `settings.save`, `catalog.refresh`, `defaults.apply`. The CLI still sends `answer`, `review.approve`, `review.reject`, `review.approve-bulk`, `campaign.create` and `ticket.add` through the same queue; the panel no longer exposes them.

Static assets are served from `assets/ui` with `no-store`, except the fonts, which are cached for a day.
