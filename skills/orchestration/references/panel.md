# Panel

A local web page served by the supervisor. It answers four questions in this order: **what is happening across every project**, **does anything need me now**, **is the system healthy and doing the right thing**, and **what happened to this one piece of work**. It is a control surface, not a dashboard: everything it shows can be acted on, and every action writes the same command queue the CLI writes.

One supervisor serves every registered project. One page, one event stream, no per-project switching.

## Shape

```
┌───────────────┬──────────────────────────────────────────────────────────┐
│ orchestration │ fleet  inbox 1  board  campaign  acceptance 2  settings  │
│               │                          dispatch auto    ● live        │
├───────────────┼──────────────────────────────────────────────────────────┤
│ CAMPAIGNS     │ FLEET                                                     │
│ habitlog  ↗   │ [All 616] [Running 1] [Queued 4] [Acceptance 2] [Done 609]│
│ 5 tickets     │ search task, project, model, queue reason…                │
│ + new         │ ┌──────────────────────────────────────────────────────┐  │
│               │ │ 03 API slice   running   pi/gemini   $0.02    12s    │  │
│               │ │ 04 Seed page   queued    4/4 slots busy          │  │
│               │ │ 05 Review      acceptance · waiting 12h          │  │
│               │ └──────────────────────────────────────────────────────┘  │
└───────────────┴──────────────────────────────────────────────────────────┘
```

Three regions pin themselves while their middle scrolls: the top bar (crumbs, views, dispatch switch, live state) to the top of the page; the rail's wordmark and its foot (counts, text size) to the top and bottom of the rail, with the campaign list scrolling between them; and the drawer's head (title, Close) and foot (actions) to the top and bottom of the drawer, with only the ticket body scrolling.

A **strip** is one ticket: a perforated number stub, the title, the kind, and telemetry (the live run's model and elapsed time, the lane it waits for, or the model that produced it). A **band** is one stage. The **ledger** under the bands is the campaign's real history, newest first.

## Screens

| Screen | Shows | Acts |
| --- | --- | --- |
| **Fleet** (default) | One row per ticket across every project plus one row per delivery waiting for acceptance; status tabs, search, project and adapter filters, quota windows, and the queue reason on every row | Open a ticket or a delivery, pause/resume dispatch, change the filters |
| **Inbox** | Every open item across projects, oldest first: questions and failures | Answer, open the ticket |
| **Acceptance** | Open delivery reviews grouped by campaign, with the changed-line count and autoship limit | Approve and merge, send back, bulk-approve one campaign under its autoship line |
| **Board** | Stage bands with their strips, the slot meter, spend, the ledger | Pause, resume, take a delivery, open a ticket |
| **Campaign** | The brief as a document (goal, brief, criteria, constraints, reading) beside the operational settings, then quotas, the model chains, the ticket list, the decisions and a new-ticket form | Edit and save, approve, pause, resume, cancel all, deliver, archive, add a ticket, add or remove a model in a chain, share a decision |
| **Settings** | Console limits, the runner adapter/spend/sandbox, provider quota windows, and the ticket kinds, each with its chain as removable chips and a searchable picker built from the selected adapter's catalog | Edit and save, discover or refresh adapter models |
| **Drawer** | One ticket in a pinned head and foot: what to build, criteria, findings, the last answer, telemetry (context, cache, speed, labelled cost), its runs and the run log streaming | Only what applies: stop while it runs, retry when it failed or was sent back, answer when it waits, a note when it has landed; plus **edit** (title, kind, paths, blockers, body, criteria) and **remove** |

Views have addresses: `#fleet?status=acceptance&project=habitlog&adapter=agy-acp&q=seed`, `#inbox`, `#board`, `#campaign`, `#campaign/<slug>`, `#acceptance`, `#settings`, and `#ticket/03` for the drawer, so a link or a screenshot points at the same thing next time. Fleet filters are client-side up to 1,000 rows; the table renders 200 at a time with **Load more**.

The campaign screen shows **one state and one set of actions**. Nothing offers "approve" once a campaign has been approved: `draft` and `awaiting_approval` offer approve, `running` offers pause and cancel, `paused` offers resume (and deliver when a delivery is waiting), `delivered` offers reopen and archive, `archived` offers nothing. A line under the buttons says what the state means right now, because the eyebrow at the top of the page scrolls away.

Dark is the default. `?theme=light` / `?theme=dark`, or the toggle at the foot of the rail, switches and remembers. A light OS setting no longer overrides the house default, because the board is meant for a dark room. The `S / M / L` control in the rail sets the text size and is remembered too: the whole scale is in `rem`, and the root grows with the window (16 px, 17 px above 1500 px wide, 18.5 px above 1900, 20 px above 2400), so a 4K screen at native resolution is readable without zooming the browser.

## Creating

**New campaign** from the rail: a goal in one sentence, a project, autonomy, landing and base. It writes `campaign.md` in `draft`, so planning continues in the Campaign screen or in a session.

**Open another repository** from the rail: browse folders, then **Open this folder**. The server validates the directory, adds it to the live project list and writes it to the console registry, so its campaigns and orchestration records appear immediately and on the next start. `GET /api/browse?path=` lists subdirectories; no string path is required in the UI.

**Cancel all** stops every live run and pauses the campaign, leaving branches for inspection. **Archive** closes a delivered or paused campaign: it leaves the board, the branches stay.

**New ticket** from the Campaign screen: title, kind, blockers, touched paths, images/PDFs, what to build, and one acceptance criterion per line. Attachments can be typed as project-relative paths or uploaded; they are stored under `orchestration/<campaign>/attachments/`. It takes the next number, and a ticket that would break the plan (unknown blocker, empty touches, no criteria) is refused with the reason and not written.

Both have CLI equivalents: `orchestrate start "<goal>"` and `orchestrate ticket add`.

**Chains are picked, never typed.** Each kind shows its models as chips (`adapter · provider/model` and thinking level), with a searchable picker listing every adapter's catalog — provider, model, context window, whether it reads images, and the price per 1M tokens when the adapter knows it. Type to filter by adapter, model, label or price; options are grouped by adapter and sorted by a blended list price (input weighted 4:1 over output), free first and unknown last; for code, design, visual and review, free/promo models are hidden by default. Subscription-only hides models outside the plan, and the adapter selector sets the default for new entries. The panel refuses a save that binds a model from the wrong catalog. The first chip starts the ticket; each one after it is a fallback. Removing a chip removes that entry; adding one appends.

## Dispatch switch

The top bar holds one console-wide switch: **Dispatch auto** or **Dispatch paused: reason**. Pausing asks for a short reason, written to `~/.local/state/orchestration/dispatch.json` and repeated on every queued Fleet row. It never touches live runs; it only stops the next claim. Resuming is one click and clears the reason.

The same switch exists on the CLI:

```
orchestrate dispatch status
orchestrate dispatch pause --reason "quota exhausted"
orchestrate dispatch resume
```

A campaign's own **Pause** is separate: it stops that campaign and still lets its live runs finish.

## Provider quota windows

The Fleet header shows every console quota window: provider, window, a bar, percent used, reset countdown, source and **stale** when the observation is old. A campaign can add windows or override a console window by provider/adapter/window; its Campaign screen shows the resolved set.

The scheduler refuses to start a model whose matching window is exhausted, and the Fleet row says which window and when it resets. It tries the next entry in the chain first, so one exhausted plan does not park a ticket that has a free fallback. Stale data is displayed but never enforced: a forgotten manual entry must not freeze the fleet. A reset time in the past clears the window.

`orchestrate quota list`, `quota set` and `quota remove` write the same console entries.

## Acceptance

Acceptance is a global queue, separate from the Inbox. It lists open delivery reviews grouped by campaign, oldest first, with the changed-line count against `max_autoship_lines`. Approve and merge is a per-item action; sending back requires a note. Bulk approval is limited to one campaign and to a delivery under its autoship line, and the server enforces that rule even if the page is bypassed. Questions and failures stay in the Inbox.

## Telemetry

The ticket drawer labels what it knows. **Actual** means the provider reported the dollars, **estimated** means tokens multiplied by the current price table, and **included** means a subscription run with an API-equivalent value that was never billed. A missing price says `cost unknown`, never `$0.00`.

The same block shows context used against the model's window (when the catalog knows it), cached-read share, and output tokens per second. Runs record adapter, adapter version and host so a later catalog or machine change cannot rewrite what produced a report. When a harness reports subagents or child runs, they appear under **Child runs** with their own model, status, tokens and dollars; the drawer also shows the rolled-up child tokens and cost. They are observation only: the scheduler never turns them into tickets.

## Rules

1. **What needs a person comes first.** An empty inbox says so in one line. A healthy campaign takes one band.
2. **A label says who is waiting and for what.** `Waiting for you` is a stage; `lane src/api/**` is a ticket waiting for a free lane.
3. **One place per concept.** The Fleet is the map, Acceptance is the delivery queue, the Board is one campaign's stages, and the Ticket is the history. Configuration lives on Campaign and Settings.
4. **Counts are lengths.** A badge says 4 only when the list it links to has four rows.
5. **Honest state.** Spend is measured and labelled actual, estimated or included. A stale quota is drawn as stale. The live dot turns hollow when the stream drops; a stale panel says `reconnecting` rather than freezing silently.
6. **The page never writes state.** Every click enqueues a command; the supervisor applies it on its next tick. Two tabs, or a tab and a CLI, cannot disagree about the file.
7. **Local only.** The server binds `127.0.0.1` and refuses non-loopback callers. The token lives in `~/.local/state/orchestration/token` (mode 0600) and does not rotate between restarts. Opening the panel once with `?token=` sets an HttpOnly cookie for the origin, so a refresh, a new tab or a bookmark needs no token; the address bar is cleaned on load so the token does not sit in history. Without either, the page asks for the link once and then reloads.

## Transport

- `orchestrate up` is the ordinary way in: it starts the supervisor if needed, opens the panel, and prints the URL. The panel writes its address, port, token and pid to `~/.local/state/orchestration/panel.json`, which is how `up` and `down` find a running one, and how `orchestrate panel` answers from any project.

**`GET /api/state`** returns the derived view: projects, campaigns, tickets, inbox, spend, effective chains, quota windows, the console dispatch state, and the last events. The page renders from this and never parses files.
- **`GET /api/events`** is `text/event-stream`. Each message carries the ledger event and its sequence id; on connect the stream replays what it still holds after `lastId`. The page refetches `/api/state` on each event, coalesced, so a gap costs a redraw and nothing else.
- **`GET /api/log?project=&campaign=&run=&offset=`** returns the next bytes of a run log with the new offset, so the drawer keeps streaming across reconnects.
- **`POST /api/commands`** takes `{ root, type, ... }` and returns the queued command. The supervisor picks it up within one tick (2 s by default).
- **`POST /api/projects`** takes `{ root }`, validates the directory, adds it to the live project list and the console registry.
- **`GET /api/browse?path=`** lists subdirectories for the folder picker; omit `path` for the home directory.
- **`POST /api/attachments`** takes `{ root, campaign, name, data }` (base64 image or PDF) and writes it under `orchestration/<campaign>/attachments/`, returning the project-relative path. Used by the new/edit ticket attachment field; 5 MB per image, 20 MB per PDF, png/jpeg/webp/gif/pdf only.

Commands: `answer`, `review.approve`, `review.reject`, `review.approve-bulk`, `retry`, `stop`, `pause`, `resume`, `approve`, `deliver`, `dispatch.pause`, `dispatch.resume`, `campaign.create`, `campaign.save`, `ticket.add`, `settings.save`, `catalog.refresh`.

Static assets are served from `assets/ui` with `no-store`, except the fonts, which are cached for a day.

## Assets

`assets/ui/index.html`, `app.js`, `styles.css`, and `fonts/` (Archivo, IBM Plex Mono, Newsreader, all OFL, vendored so the panel renders identically offline). No framework, no bundler, no network at runtime.

The look is deliberate: a cool ink-blue black with a recessed chrome layer, one warm signal colour, three typefaces with three jobs (a serif document, a grotesk interface, a mono instrument), hairlines instead of cards, one signal colour used only for the thing that needs a person, and a perforated stub on every strip. Structure is sharp; controls are the only rounded edges.

## What it must not become

- A chat window. Conversation belongs in the ticket and its session, not in a terminal in the browser.
- A second editor. Every panel write goes through the same validation as the CLI.
- A progress bar for its own sake. A campaign's position is the set of ticket stages, not a percentage.
- A button that cannot do anything. A landed ticket shows a note, not a stop button.
