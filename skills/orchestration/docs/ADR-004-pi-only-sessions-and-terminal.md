# ADR-004: pi-only sessions and an embedded worker terminal

> Superseded in part by [ADR-005](ADR-005-standalone-tauri-app.md): pi remains
> the default runtime, but agy is allowed for explicit Gemini tickets in the
> standalone app.

- **Status:** Accepted
- **Date:** 2026-11-15
- **Scope:** `skills/orchestration`
- **Related:** [ADR-003](ADR-003-ticket-steering.md)

## Context

The panel can show a campaign, its tickets and a raw run log, but a ticket
worker is still a black box. A person can read a 6,000-line JSONL log, or send a
steering note, but cannot watch the worker as a conversation or enter its
session and finish the work directly.

The runtime is also fragmented. `pi`, `agy-acp` and `opencode-acp` are three
different session models. Only `pi` has a native TUI that can be attached to a
session. ACP sessions need a separate ACP client, and the panel's terminal
cannot be made adapter-generic without doubling the UI.

The human-facing goal is:

- every ticket has one readable session, organized by campaign and ticket;
- the session can be observed live;
- the session can be entered safely;
- a person can hand the ticket back without bypassing review and delivery.

## Decision

### 1. pi is the only ticket runtime

All new work, review, judge and merge runs use `pi`.

- Gemini is a pi model binding, not an ACP call:
  `{ adapter: "pi", model: "opencode-go/gemini-4-argon" }`.
- `agy-acp` and `opencode-acp` are frozen for legacy campaigns that already
  exist. They can finish and archive on their adapter, but no new campaign or
  ticket is bound to them.
- Legacy ACP campaigns are marked `legacy` in the panel and do not expose the
  pi terminal.
- A pi extension may later expose `agy acp` as a delegated tool. That is a
  child agent, not a top-level ticket runtime, and is out of scope for v1.

### 2. One session per ticket, not one per run

The ticket is the durable thread. Work attempts, human takeover turns and gate
runs are events inside that thread.

- The pi session id is derived from the ticket and role; a work resume reuses
  the same session id.
- Review, judge and merge sessions are separate pi sessions and appear as
  collapsed, read-only **Gate** cards.
- A gate session is fork-only. A human fork is advisory and cannot change the
  gate result.

### 3. Single-writer lease

A ticket session has one owner: `supervisor` or `human`.

- The supervisor refuses to dispatch a ticket whose `owner` is `human`.
- A live work session cannot be attached to directly. The panel offers:
  - **Fork**: a read-only copy with `read,grep,find,ls`;
  - **Stop and take over**: stop the live run, keep the session and worktree,
    and set `owner: "human"`.
- Human-owned tickets stay in stage `working` with a `human` chip. No new stage
  is added.
- There is no auto-resume when a terminal dies. The ticket stays human-owned
  until **hand back** or **release**.

### 4. Hand-back goes through the gate

Hand-back requires a short human note. The supervisor resumes the same pi
session with a hand-back prompt that asks the worker to:

1. inspect the human's changes;
2. run the campaign checks;
3. write a structured report with acceptance evidence.

That resumed turn does not consume an attempt. It then follows the normal
review and integration path. If the branch did not change, the gate is skipped
and the previous state resumes.

### 5. Embedded terminal

The panel gets a full-page **Sessions** workspace:

- ticket list on the left, terminal on the right;
- desktop only; mobile gets the transcript and inbox;
- `xterm.js` in the browser, a PTY and WebSocket bridge on the server;
- optional dependencies (`node-pty`, `ws`, `@xterm/addon-fit`) with a graceful
  fallback to **copy command / native handoff**;
- loopback only; remote use goes through an SSH tunnel;
- detach/reattach while the panel runs, 30-minute idle TTL;
- panel restart kills the PTY, but the pi session file survives;
- one active terminal per ticket, no general shell.

### 6. Inbox remains the durable queue

Inline answers and inbox items are the same question record.

- The item is created immediately when a worker asks.
- An inline answer closes the same item.
- The worker parks and frees its slot immediately; it never holds a slot while
  waiting for chat.
- While attached, the leader may answer technical/implementation questions with
  a citation. Scope, acceptance criteria, budget, secrets, destructive actions
  and delivery escalate to the human.

### 7. Accounting

Every terminal turn is a human-session turn:

- tokens and dollars are attributed to the ticket and campaign;
- it does not consume an attempt or a dispatch slot;
- forks are labelled **observation** and reported separately;
- `CLOSE.md` reports human-session spend separately.

## Consequences

- The panel becomes an interactive surface for work sessions; it stops being
  purely a monitor. The "no chat" rule from ADR-003 applies to the campaign and
  gate decisions, not to a work session the human explicitly owns.
- A second native dependency surface exists for the terminal. The panel must
  keep working without it.
- The supervisor and terminal must agree on the lease. A stale human lease
  parks a ticket; it never silently dispatches a second run into a half-edited
  worktree.
- Legacy ACP campaigns cannot use the new terminal. That is deliberate.

## Rejected options

- **Make ACP sessions first-class in the terminal.** Doubles the terminal
  integrations and keeps the runtime fragmented.
- **Let the supervisor and terminal attach to the same live session.** Two
  writers to one pi session; data loss and conflicting edits.
- **Skip review for human edits.** Makes takeover a gate bypass.
- **Delete the inbox and rely on chat.** Breaks unattended runs, restarts,
  fleet triage and the audit trail.
- **Auto-resume when the terminal exits.** Dispatches a fresh run into a
  half-edited worktree.

## Implementation notes

- Lease fields live on `state.tickets[id]`: `owner`, `lease`, `sessionId`,
  `workdir`.
- Commands: `session.takeover`, `session.handback`.
- Transport: `GET /api/terminal/status`, WebSocket `/api/terminal`.
- Transcript: `GET /api/transcript` reads the pi session JSONL.
- xterm.js is vendored under `assets/ui/vendor/xterm/` with its MIT license.
- `node-pty` and `ws` are loaded through an optional resolver; the panel
  reports `terminal unavailable` when they are missing.
