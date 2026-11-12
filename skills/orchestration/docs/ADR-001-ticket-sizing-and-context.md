# ADR-001: Ticket sizing, dependency context, and failure attention

- **Status:** Accepted
- **Date:** 2026-11-13
- **Scope:** `skills/orchestration`
- **Supersedes:** the “aim for 3–7 tickets” guidance in `SKILL.md` and the
  fragmentation-only sizing rule in `references/protocol.md`

## Context

The orchestration skill turns a goal into a ticket graph. That is useful for
work that genuinely has independent slices, but the previous guidance (“aim for
3–7 tickets”) encouraged the agent to split one request into many tickets even
when the request had one user-visible outcome.

The `dsh-superagent` prototype uses a different model:

- one accepted source message creates **at most one ticket**;
- a ticket is a unit of authorized work with one owner and one session;
- follow-up messages resume that ticket;
- a Thread may contain several tickets, but only for genuinely separate pieces
  of work;
- the worker uses subagents internally instead of creating sub-tickets.

That model avoids a whole class of failure:

- every split creates a handoff, and the next worker starts without the
  previous worker’s reasoning;
- dependent tickets serialize work and wait on each other;
- each ticket costs a work run and a review run;
- each blocked or failed ticket can create another inbox item;
- many small tickets duplicate shared context and lower cache efficiency.

The observed symptoms were:

- workers losing context after a split;
- tickets reporting `blocked` because the missing information lived in a
  previous worker’s session;
- tickets reporting `dropped` when a later worker could not see that the work
  was still needed;
- inboxes filling with one failure item per ticket.

## Decision

### 1. One ticket is the default

A ticket is a **user-visible, independently verifiable outcome**, not a file,
a layer, a step, or a context chunk.

- Start with one ticket for one outcome.
- Split only when **all** of these hold:
  1. the slice is independently demoable or verifiable;
  2. the slice has its own acceptance criteria;
  3. the slice can proceed without reconstructing another worker’s reasoning,
     or the split earns its handoff through real parallelism or isolation.
- Two or three tickets are normal for a genuinely independent parallel effort.
- Four tickets trigger a budget warning.
- Six or more asks for a written reason in the plan.
- The hard cap remains 16.
- Never split by file, by layer (schema/API/UI/tests), or into a
  “prepare”/“use it” pair.

This is a planning rule, not a new workflow stage or per-campaign setting.

### 2. Dependency context travels with the ticket

When ticket B is blocked by ticket A, B’s worker prompt includes a
**Completed blockers** section with:

- A’s id and title;
- A’s final summary;
- the files A reported touching;
- A’s acceptance results and evidence.

This is context, not authority: it cannot widen B’s scope. If it contradicts
the ticket, the worker reports the contradiction instead of silently choosing
one.

The integration branch and `orchestrate context --ticket` remain available;
the dependency packet removes the need to reverse-engineer A’s reasoning from
the diff alone.

### 3. Generic ticket failures aggregate at campaign level

Failure items that describe the same failure class are grouped into one
campaign-level inbox item:

- `ticket-failed` — a ticket exhausted its attempts;
- `gate-cycles` — a ticket failed its gates three times;
- `review-broken` — a review run produced no report;
- `land-failed` — a reviewed ticket could not land.

The item carries `tickets`, `details`, a combined brief, and per-ticket
findings. Specific exceptional failures keep their own item:

- a review whose branch changed after the pass (`reviewStale`);
- an integration check failure;
- a delivery audit failure;
- a budget pause.

This keeps the inbox readable without hiding which tickets are affected.

### 4. Budget warning is proportional to cost

The warning states the real cost:

```text
4 tickets means at least 8 work/review runs and 4 separate context
reconstructions. Split only when each slice is independently demoable;
otherwise merge it into one vertical ticket.
```

At six or more it adds: “Add a written reason for this many slices before
approving.”

The warning does not block approval. The existing fragmentation rule still
blocks four or more one-path, one-criterion slices unless explicitly accepted.

## Consequences

### Positive

- Fewer context handoffs and fewer lost decisions.
- Fewer work/review runs for the same outcome.
- Less inbox noise from many parked tickets.
- Dependency workers get the outcome and evidence of their blockers.
- The skill still supports genuinely parallel campaigns.
- Prompt-cache prefixes stay more stable because fewer tickets repeat the
  same campaign context.

### Negative

- A single ticket may run longer and touch more paths.
- A larger ticket needs a strong acceptance list and a good check command;
  otherwise the review has less to judge.
- Aggregated failure items are less directly tied to one ticket in the inbox;
  the `tickets` field and findings carry that information.
- A genuinely independent five-slice campaign now sees a warning it must
  justify.

### Neutral

- No new command, workflow stage, or per-campaign setting.
- Existing campaigns keep their tickets; this changes planning guidance and
  new failure items, not historical state.
- The one-ticket path (`ticket add`) remains a first-class path.

## Alternatives considered

### Keep “aim for 3–7 tickets”

Rejected: it optimizes for parallelism that a single request usually does not
have, and it was the direct cause of the observed context loss.

### Copy the prototype’s “one source message = one ticket” literally

Rejected: this skill’s input is a campaign goal, not a stream of source
messages. A multi-slice campaign can be legitimate. The useful part is the
**default**, not a prohibition on splitting.

### Auto-split by layer or file

Rejected: layer tickets are not independently demoable, and file tickets create
the worst handoffs.

### Keep one failure item per ticket

Rejected for generic failure classes: it turns a plan-level problem into N
inbox messages. Exceptional, ticket-specific failures still keep their own
item.

## Implementation

- `scripts/lib/plan-import.mjs` — `PLAN_LIMITS` soft/strong ticket budgets.
- `scripts/lib/plan-draft.mjs` — `ticket-budget` warning.
- `scripts/lib/prompts.mjs` — rendered dependency packet.
- `scripts/lib/engine.mjs` — collect blocker summaries, evidence, and files;
  group generic failure items.
- `scripts/lib/inbox.mjs` — preserve `group`, `tickets`, and `details` on items.
- `references/worker-prompt.md` — **Completed blockers** section.
- `SKILL.md`, `references/protocol.md`, `references/config.md` — one-ticket
  default and budget rule.
- Tests cover the warning, the dependency packet, and failure aggregation.

## Verification

```bash
node --test tests/*.test.mjs
node --test tests/panel.e2e.mjs
node evals/run.mjs
```
