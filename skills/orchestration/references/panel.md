# Panel

A local web page served by the supervisor. It answers three questions in this order: **does anything need me now**, **is the system healthy and doing the right thing**, and **what happened to this one piece of work**. It is a control surface, not a dashboard: everything it shows can be acted on, and every action writes the same command queue the CLI writes.

One supervisor serves every registered project. One page, one event stream, no per-project switching.

## Shape

```
┌───────────────┬──────────────────────────────────────────────────────────┐
│ orchestration │ habitlog · delivered      inbox 1  board  campaign  settings │
├───────────────┼──────────────────────────────────────────────────────────┤
│ CAMPAIGNS     │ DELIVERED                                                 │
│ habitlog  ↗   │ habitlog                                                  │
│ 5 tickets     │ ▮▮▯▯ 0/4 slots  trusted  branch → main  145,885 tok       │
│ + new         │ ─────────────────────────────────────────────────────────  │
│               │ DONE 5                                                    │
│               │ 01 │ Storage: append and read entries      code   deepseek │
│               │ 02 │ Streaks: current and best              code   deepseek │
│               │                                                           │
│               │ LEDGER                          newest first · 9 of 40  │
│               │ 19:32  05  gate review                         pass       │
└───────────────┴──────────────────────────────────────────────────────────┘
```

Three regions pin themselves while their middle scrolls: the top bar (crumbs, views, live state) to the top of the page; the rail's wordmark and its foot (counts, text size) to the top and bottom of the rail, with the campaign list scrolling between them; and the drawer's head (title, Close) and foot (actions) to the top and bottom of the drawer, with only the ticket body scrolling.

A **strip** is one ticket: a perforated number stub, the title, the kind, and telemetry (the live run's model and elapsed time, the lane it waits for, or the model that produced it). A **band** is one stage. The **ledger** under the bands is the campaign's real history, newest first.

## Screens

| Screen | Shows | Acts |
| --- | --- | --- |
| **Inbox** (default) | Every open item across projects, oldest first: questions, deliveries, failures | Answer, approve, send back, open the ticket |
| **Board** | Stage bands with their strips, the slot meter, spend, the ledger | Pause, resume, take a delivery, open a ticket |
| **Campaign** | The brief as a document (goal, brief, criteria, constraints, reading) beside the operational settings, then the model chains, the ticket list, the decisions and a new-ticket form | Edit and save, approve, pause, resume, cancel all, deliver, archive, add a ticket, add or remove a model in a chain, share a decision |
| **Settings** | Console limits and the ticket kinds, each with its chain as removable chips and a picker built from the selected adapter's catalog; the runner adapter, spend mode and sandbox | Edit and save, discover or refresh adapter models |
| **Drawer** | One ticket in a pinned head and foot: what to build, criteria, findings, the last answer, its runs with model and cost, and the run log streaming | Only what applies: stop while it runs, retry when it failed or was sent back, answer when it waits, a note when it has landed; plus **edit** (title, kind, paths, blockers, body, criteria) and **remove** |

Views have addresses: `#inbox`, `#board`, `#campaign`, `#campaign/<slug>`, `#settings`, and `#ticket/03` for the drawer, so a link or a screenshot points at the same thing next time.

The campaign screen shows **one state and one set of actions**. Nothing offers "approve" once a campaign has been approved: `draft` and `awaiting_approval` offer approve, `running` offers pause and cancel, `paused` offers resume (and deliver when a delivery is waiting), `delivered` offers reopen and archive, `archived` offers nothing. A line under the buttons says what the state means right now, because the eyebrow at the top of the page scrolls away.

Dark is the default. `?theme=light` / `?theme=dark`, or the toggle at the foot of the rail, switches and remembers. A light OS setting no longer overrides the house default, because the board is meant for a dark room. The `S / M / L` control in the rail sets the text size and is remembered too: the whole scale is in `rem`, and the root grows with the window (16 px, 17 px above 1500 px wide, 18.5 px above 1900, 20 px above 2400), so a 4K screen at native resolution is readable without zooming the browser.

## Creating

**New campaign** from the rail: a goal in one sentence, a project, autonomy, landing and base. It writes `campaign.md` in `draft`, so planning continues in the Campaign screen or in a session.

**Open another repository** from the rail: browse folders, then **Open this folder**. The server validates the directory, adds it to the live project list and writes it to the console registry, so its campaigns and orchestration records appear immediately and on the next start. `GET /api/browse?path=` lists subdirectories; no string path is required in the UI.

**Cancel all** stops every live run and pauses the campaign, leaving branches for inspection. **Archive** closes a delivered or paused campaign: it leaves the board, the branches stay.

**New ticket** from the Campaign screen: title, kind, blockers, touched paths, images/PDFs, what to build, and one acceptance criterion per line. Attachments can be typed as project-relative paths or uploaded; they are stored under `orchestration/<campaign>/attachments/`. It takes the next number, and a ticket that would break the plan (unknown blocker, empty touches, no criteria) is refused with the reason and not written.

Both have CLI equivalents: `orchestrate start "<goal>"` and `orchestrate ticket add`.

**Chains are picked, never typed.** Each kind shows its models as chips (`adapter · provider/model` and thinking level), with a searchable picker listing every adapter's catalog — provider, model, context window, whether it reads images, and the price per 1M tokens when the adapter knows it. Type to filter by adapter, model, label or price; options are grouped by adapter and sorted by a blended list price (input weighted 4:1 over output), free first and unknown last; for code, design, visual and review, free/promo models are hidden by default. Subscription-only hides models outside the plan, and the adapter selector sets the default for new entries. The panel refuses a save that binds a model from the wrong catalog. The first chip starts the ticket; each one after it is a fallback. Removing a chip removes that entry; adding one appends.

## Rules

1. **What needs a person comes first.** An empty inbox says so in one line. A healthy campaign takes one band.
2. **A label says who is waiting and for what.** `Waiting for you` is a stage; `lane src/api/**` is a ticket waiting for a free lane.
3. **One place per concept.** Stages on the Board, history on the Board's ledger and the Ticket, configuration on Campaign and Settings.
4. **Counts are lengths.** A badge says 4 only when the list it links to has four rows.
5. **Honest state.** Spend is measured. The live dot turns hollow when the stream drops; a stale panel says `reconnecting` rather than freezing silently.
6. **The page never writes state.** Every click enqueues a command; the supervisor applies it on its next tick. Two tabs, or a tab and a CLI, cannot disagree about the file.
7. **Local only.** The server binds `127.0.0.1` and refuses non-loopback callers. The token lives in `~/.local/state/orchestration/token` (mode 0600) and does not rotate between restarts. Opening the panel once with `?token=` sets an HttpOnly cookie for the origin, so a refresh, a new tab or a bookmark needs no token; the address bar is cleaned on load so the token does not sit in history. Without either, the page asks for the link once and then reloads.

## Transport

- `orchestrate up` is the ordinary way in: it starts the supervisor if needed, opens the panel, and prints the URL. The panel writes its address, port, token and pid to `~/.local/state/orchestration/panel.json`, which is how `up` and `down` find a running one, and how `orchestrate panel` answers from any project.

**`GET /api/state`** returns the derived view: projects, campaigns, tickets, inbox, spend, effective chains, the last events. The page renders from this and never parses files.
- **`GET /api/events`** is `text/event-stream`. Each message carries the ledger event and its sequence id; on connect the stream replays what it still holds after `lastId`. The page refetches `/api/state` on each event, coalesced, so a gap costs a redraw and nothing else.
- **`GET /api/log?project=&campaign=&run=&offset=`** returns the next bytes of a run log with the new offset, so the drawer keeps streaming across reconnects.
- **`POST /api/commands`** takes `{ root, type, ... }` and returns the queued command. The supervisor picks it up within one tick (2 s by default).
- **`POST /api/projects`** takes `{ root }`, validates the directory, adds it to the live project list and the console registry.
- **`GET /api/browse?path=`** lists subdirectories for the folder picker; omit `path` for the home directory.
- **`POST /api/attachments`** takes `{ root, campaign, name, data }` (base64 image or PDF) and writes it under `orchestration/<campaign>/attachments/`, returning the project-relative path. Used by the new/edit ticket attachment field; 5 MB per image, 20 MB per PDF, png/jpeg/webp/gif/pdf only.

Commands: `answer`, `review.approve`, `review.reject`, `retry`, `stop`, `pause`, `resume`, `approve`, `deliver`, `campaign.create`, `campaign.save`, `ticket.add`, `settings.save`, `catalog.refresh`.

Static assets are served from `assets/ui` with `no-store`, except the fonts, which are cached for a day.

## Assets

`assets/ui/index.html`, `app.js`, `styles.css`, and `fonts/` (Archivo, IBM Plex Mono, Newsreader, all OFL, vendored so the panel renders identically offline). No framework, no bundler, no network at runtime.

The look is deliberate: a cool ink-blue black with a recessed chrome layer, one warm signal colour, three typefaces with three jobs (a serif document, a grotesk interface, a mono instrument), hairlines instead of cards, one signal colour used only for the thing that needs a person, and a perforated stub on every strip. Structure is sharp; controls are the only rounded edges.

## What it must not become

- A chat window. Conversation belongs in the ticket and its session, not in a terminal in the browser.
- A second editor. Every panel write goes through the same validation as the CLI.
- A progress bar for its own sake. A campaign's position is the set of ticket stages, not a percentage.
- A button that cannot do anything. A landed ticket shows a note, not a stop button.
