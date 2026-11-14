# ADR-002: Bounded context packets and prompt budgets

- **Status:** Accepted
- **Date:** 2026-11-14
- **Scope:** `skills/orchestration`
- **Related:** [ADR-001](ADR-001-ticket-sizing-and-context.md)

## Context

A parent worker or agent already holds context that a child worker or subagent
needs. Passing the whole transcript is expensive and noisy. Passing only a
ticket title makes the child re-explore and re-verify work the parent already
did.

The skill already had:

- campaign brief, constraints, reading and path-relevant decisions in the
  worker prompt;
- a dependency section with the blocker’s summary, touched files and acceptance
  evidence;
- `orchestrate context --ticket`.

It lacked:

- a subagent handoff rule;
- a compact, structured packet for a child;
- prompt-size caps;
- prompt-cost telemetry.

## Decision

### 1. A child gets a packet, never a transcript

The standing contract and worker prompt now require a bounded packet:

- task and scope;
- verified facts with sources;
- decisions;
- artifacts;
- commands already run;
- files to read;
- a do-not-recheck list.

A child may re-check only a changed source or a high-risk claim, and reports a
contradiction instead of silently choosing a side.

### 2. `context --packet` is the handoff surface

`orchestrate context --ticket <id> --packet` emits JSON with:

```text
version, campaign, goal, ticket,
dependencies, verified_facts, decisions, artifacts,
commands_run, do_not_recheck, open_questions,
read_first, integration
```

`verified_facts` are built only from passed acceptance results that include
evidence. A summary alone is never promoted to a fact.

### 3. Prompt fields are bounded

`PROMPT_LIMITS` caps:

- brief, constraints, reading and ticket body;
- decision count and decision text;
- dependency count, summary and acceptance evidence.

A clipped field keeps an explicit `… [truncated; N chars]` marker. It never
silently disappears.

### 4. Context cost travels with the run

Every work/review/judge/merge run records:

```json
{
  "context": {
    "promptChars": 0,
    "promptTokensEstimate": 0,
    "dependencyChars": 0,
    "dependencyCount": 0,
    "decisionChars": 0,
    "decisionCount": 0
  }
}
```

The panel shows the estimate and dependency/decision sizes in the run
telemetry.

## Consequences

### Positive

- Less duplicate exploration and duplicate verification.
- Subagents receive only the context they can use.
- Prompt size regressions are visible.
- Prompt prefixes stay stable and cache-friendly because the variable task and
  bounded packet remain at the end.
- A child can still fetch more from referenced paths when needed.

### Negative

- A packet can omit a fact that later turns out to matter; the child must follow
  `read_first` or report the gap instead of guessing.
- Clipping can hide detail; the truncation marker and source path preserve the
  route to it.
- The parent must maintain a good packet rather than dumping text.

### Neutral

- The packet is a view over recorded state, not a new source of truth.
- No new setting; the caps are policy constants.

## Verification

- `tests/context-packet.test.mjs` checks evidence-only facts, dependencies,
  commands, open questions and `read_first`.
- `tests/prompts.test.mjs` checks dependency checks/handoff data and clipping.
- `tests/engine.test.mjs` checks that a dependent run receives the packet and
  records prompt telemetry.
- `tests/cli.test.mjs` checks `context --packet` JSON.
