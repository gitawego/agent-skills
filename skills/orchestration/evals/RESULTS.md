# Eval results

Run: `node evals/run.mjs`. Six of the seven evals have expectations a program can
check; they run against a throwaway project with a scripted worker.

```
PASS  eval 1 — approval refuses an unbound kind and names the bind command
PASS  eval 2 — an unknown model is refused and the catalog is offered
PASS  eval 3 — a bind is refused while the campaign is running
PASS  eval 4 — the running panel prints a loopback URL with a token
PASS  eval 6 — a supervised campaign waits for a person and does not merge
PASS  eval 7 — free-form context becomes a reviewed draft and one import

6/6 executable expectations passed, 0 skipped
```

## What is not executed here

| Eval | Why | How it was checked instead |
| --- | --- | --- |
| 1, planning half ("creates campaign.md with goal, brief, criteria, constraints, reading list") | Requires a model driving the skill | Ran by hand on `habitlog` and `habit-notes`; both campaigns carry all five sections |
| 2, choosing a model ("offers 2-4 real ids with reasoning") | Judgement, not a fixed output | The catalog is now a picker in the panel, so the choice cannot be fabricated; `orchestrate catalog` prints the same 41 rows |
| 5 ("a worker asked which migration order — handle it") | Needs a live worker that asks | Covered by `tests/memory.test.mjs`: identical question answered from memory without a judge, reworded question answered by the judge with a citation, unsourced question escalated to the inbox |
| 6, "shows the review item with line counts" | Requires the panel | Verified in the browser against `habitlog` (745 lines, review item, merged only after approval) |
| 7, "presents the draft and fine-tunes in chat" | Requires a model driving the skill | Exercised on a real habit-cli project in `/tmp`: context, draft, a revision delta, `plan show`, `plan import`, `approve`, and a delivered campaign |

A strict eval harness would run each prompt through a fresh agent and grade the
transcript. That is worth adding when there is more than one judge model to
compare against; until then these six checks catch the regressions that matter.
