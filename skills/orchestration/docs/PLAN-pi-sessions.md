# Plan: pi-only sessions and the embedded terminal

Design: [ADR-004](ADR-004-pi-only-sessions-and-terminal.md).

## Scope

In:

- pi-only ticket sessions;
- session transcript endpoint and Sessions workspace;
- embedded terminal (xterm.js + PTY + WebSocket);
- single-writer lease, fork, takeover, hand-back;
- inline inbox answers over the same question record;
- terminal spend accounting;
- legacy ACP badge and no new ACP bindings.

Out:

- agy plugin;
- ACP terminal viewer;
- tmux persistence;
- direct remote access;
- mobile terminal;
- general shell;
- multiple simultaneous terminals per ticket.

## Stage 1 — read-only observability

- [x] Add `paths.sessions`, `session` metadata and `owner` to `campaignView`.
- [x] Add `GET /api/transcript` for a pi session JSONL.
- [x] Add `Sessions` campaign tab.
- [x] Render one ticket thread: user/assistant messages, tool cards, usage.
- [ ] Add a raw-log disclosure.
- [x] Tests: transcript parser, view fields, session tab.

## Stage 2 — terminal vertical slice

- [x] Vendor xterm.js and its MIT license under `assets/ui/vendor/xterm/`.
- [x] Add `scripts/lib/terminal.mjs`: optional `node-pty` + `ws` resolver,
      PTY registry, 30-minute detach TTL, one PTY per ticket.
- [x] Add `GET /api/terminal/status` and WebSocket `/api/terminal`.
- [x] Add the terminal pane to the Sessions workspace.
- [x] Fallback to copy command when dependencies are missing.
- [x] Tests: status endpoint refuses unknown projects and live attach; PTY
      bridge test skips when dependencies are absent.

## Stage 3 — lease and takeover

- [x] Add `owner`, `lease`, `sessionId` and `workdir` to ticket state.
- [x] Add `session.takeover` and `session.handback` commands.
- [x] Skip human-owned tickets in `dispatchFrontier`.
- [x] Add queue reason "owned by a human session".
- [x] Takeover kills the live run, keeps the worktree and sets `owner: human`.
- [x] Hand-back resumes the same pi session with a hand-back prompt, runs
      checks, writes a report, then follows review/integration; no attempt is
      consumed.
- [x] Tests: takeover stops the run, dispatch skips, hand-back resumes same
      session, review still runs.

## Stage 4 — inbox and accounting

- [x] Answer inline from the session; close the same inbox item.
- [x] Create the inbox item immediately when a worker asks.
- [x] Record terminal turns as human-session spend; label forks observation.
- [x] Add human-session spend to `CLOSE.md`.
- [x] Authority matrix in the leader prompt: technical answers with citation;
      escalate scope, acceptance, budget, secrets, destructive actions and
      delivery.
- [ ] Tests: inline answer resumes, spend attribution, close report.

## Stage 5 — legacy and docs

- [x] Badge legacy ACP campaigns.
- [x] Refuse new ACP bindings with a migration hint.
- [x] Update `README.md`, `SKILL.md`, `references/panel.md`, `references/protocol.md`.
- [x] Panel e2e: session tab, transcript, terminal fallback, takeover buttons.

## Acceptance

- A finished pharmacy ticket opens in the Sessions workspace and shows a
  readable transcript.
- A live ticket can be forked read-only.
- Takeover stops the run, opens the same session and refuses a second writer.
- Hand-back produces a report, runs review and integration, and does not
  consume an attempt.
- Closing the browser leaves the ticket human-owned; the panel never
  auto-dispatches into the worktree.
- Without `node-pty`/`ws`, the panel still works and shows an actionable
  fallback.
- All existing tests and the panel e2e pass.
