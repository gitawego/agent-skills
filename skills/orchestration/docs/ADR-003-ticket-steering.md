# ADR-003: Steering a working ticket

- **Status:** Accepted
- **Date:** 2026-11-14
- **Scope:** `skills/orchestration`
- **Related:** [ADR-002](ADR-002-bounded-context-packets.md)

## Context

A person can answer a ticket only when it reports `needs_answer`. When a
ticket is already `working`, the worker has no supported way to receive a new
instruction. The run is a detached process with `stdin` ignored, so there is no
live chat channel; a new message has to become a new turn.

## Decision

### 1. Steering is a human action, not a model retry

A steer is a short human note attached to a ticket:

- `interrupt` (default): stop the current work turn, keep the same session and
  worktree, and resume with the note;
- `wait`: queue the note for the next natural resume; if the ticket lands
  first, mark it `expired` and leave the ticket history alone.

Steering never consumes `attempts` or `max_attempts`, does not change the model
chain, and does not create a repair ticket.

### 2. Refuse when the session cannot be preserved

Before killing a live run, check that its adapter can resume a session and that
a session id is known. Otherwise refuse with an actionable message. Never kill
a run and silently start a fresh session under the name “steer”.

If the worker has already written a report but the supervisor has not collected
it, do not discard the report; queue the note and let the normal gate decide.

### 3. Steering is agent-chat/CLI, not panel chat

The primary surface is:

```bash
orchestrate steer <ticket> "message" [--campaign <slug>] [--wait]
orchestrate steer <ticket> --cancel
```

The panel shows pending/delivered/cancelled notes in the ticket drawer and
offers a binary **Cancel** action. It has no steering textarea. A sentence with
context belongs in the agent conversation.

### 4. State is explicit

`state.tickets[id]` gains:

```json
{
  "steers": [
    {
      "id": "s-...",
      "text": "...",
      "at": "...",
      "by": "human",
      "mode": "interrupt | wait",
      "status": "pending | delivered | cancelled | expired",
      "deliveredAt": "...",
      "run": "r-..."
    }
  ],
  "steerCount": 0,
  "steerInterrupted": false
}
```

The full text lives in state; the ledger records `ticket.steered`,
`steer.delivered`, `steer.cancelled` and `steer.expired` with a preview,
character count and status.

Limits: 2,000 characters per steer, 5 pending per ticket. Multiple pending notes
are combined into one resumed human turn.

### 5. Attention is counted

An `interrupt` steer counts as a human action. A `wait` steer does not, because
it does not interrupt work. `attentionOf` and `CLOSE.md` report `steers`.

## Consequences

### Positive

- A person can correct a running worker without losing its session.
- The worker sees the note in the same context, ahead of gate findings.
- Finished work is never silently discarded by a late steer.
- The panel stays a monitoring surface, not a chat client.
- The attempt budget remains about model reliability, not human interruptions.

### Negative

- A hard steer interrupts in-flight work; the worker must inspect a possibly
  dirty worktree on resume.
- A soft steer can expire without being read if the ticket lands.
- Adapters without a resumable session cannot be hard-steered.

## Verification

- engine tests: interrupt, same-session resume, attempt budget, soft expiry,
  cancel, refusals and limits;
- prompt tests: steering precedes findings and carries the scope warning;
- panel e2e: steering section and cancel action;
- `protocol.md`, `SKILL.md`, `panel.md`, `README.md` updated.
