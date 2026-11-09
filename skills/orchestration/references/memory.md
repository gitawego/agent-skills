# Memory

The colony's memory is a decision log. A **decision** is one thing that was settled, written by the supervisor and read by everyone who works on the same ground. It is the only shared substrate besides the plan and the ledger, and it is the answer to "why does this system not need a meeting".

## What a decision is

One entry in `.orchestration/<campaign>/decisions.jsonl`, and in `~/.local/state/orchestration/decisions.jsonl` once promoted:

```json
{
  "id": "d-4f1c9a02",
  "ts": "2026-11-09T19:40:12Z",
  "campaign": "habitlog",
  "ticket": "02",
  "text": "Backfill oldest first.",
  "cite": "campaign.md § Constraints",
  "by": "human",
  "paths": ["src/store.mjs"],
  "question": "Which backfill order?",
  "questionHash": "9f2c1a77b3d0",
  "supersededBy": null,
  "promoted": false
}
```

`paths` is what makes it findable: the ticket's declared `touches` at the moment it was answered. `questionHash` is a normalised hash of the ask, so the same question can be recognised even when the wording moves.

## When one is written

- A person answers an inbox question (`answer`).
- The orchestrator's judge answers from a written source, with its citation.
- Never by a worker. Workers read decisions; they do not get to write the colony's memory. That single-writer rule is what keeps the substrate trustworthy.

Rejecting a review with findings is not a decision: it is instructions for one piece of work.

## How they are used

**Workers** receive the decisions whose `paths` overlap their ticket's `touches`, plus every decision with no paths (a general rule). A decision about `src/api/**` is noise on a docs ticket, and a prompt full of noise is how a growing memory turns into context rot.

**The judge** reads all active decisions before asking anyone. And before the judge is even started, the supervisor looks for a decision with the same `questionHash`; a hit is answered from memory with no model call. Re-running a ticket asks the same question twice, and the second ask should be a lookup.

**Anyone** can pull the whole picture: `orchestrate context --ticket 03` prints the decisions that bear on that ticket, what the other tickets are doing, the integration diff and the recent history. The worker prompt points at it, which is why the prompt itself can stay short.

## Supersession, not deletion

A decision is retired when a later one answers the same question (`questionHash`), or makes the same claim about the same set of paths. It is marked `supersededBy`, never removed: the ledger of what was once believed is part of the audit trail.

Mere path overlap does not supersede. A decision about `src/**` does not silently retire one about `src/api/x.ts`; both stay, and the judge chooses. Broad claims are not replacements.

`orchestrate decisions <campaign> --all` shows the retired ones with their successor.

## Promotion

Most decisions are local: an ordering, a naming, a schema choice. A few are machine-wide — "`muse-spark` reports zero usage", "run `node --test` without a path".

`orchestrate promote <id> [campaign]`, or **share** in the panel, copies one decision into the console log, where every campaign reads it. Deliberate, never automatic: a shared layer that fills itself becomes a landfill every prompt has to wade through.

## The close report

At delivery the supervisor writes `orchestration/<campaign>/CLOSE.md`: what landed, what was dropped, per-ticket model and cost and attempts, the decisions made, the checks that ran, and the tickets that needed more than one try.

It is the pheromone that survives the campaign. The ledger is the audit trail; `CLOSE.md` is what a person reads before starting the next one. It is written, never compacted — the ledger is not rewritten to save space.

## The trace is checked, not trusted

A worker's report is a marker, and a marker is cheap to write. Two checks keep it honest, and both read the environment rather than the claim:

- **The checks run by the supervisor**, not taken from the report.
- **The diff against the declared paths.** A `ready` report is only accepted if the ticket branch changes something and every changed file matches the ticket's `touches`. A change that escapes them is sent back with the file named, because `touches` is the promise the scheduler used to decide what could run in parallel.

The report still carries what only the worker knows: what it could not do, and why.
