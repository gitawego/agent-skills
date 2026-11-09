# Spec

The design record for `skills/orchestration/`. What was decided, why, and what is built in which order. Read this before changing behaviour; read `SKILL.md` and `references/` before using it.

## The shape in one paragraph

A campaign is one paragraph of intent plus a set of tickets with blocking edges. A supervisor process reads the plan, dispatches each ready ticket as a headless `pi` worker in its own worktree on a bound model, collects a structured report, runs deterministic checks and a cold review, and lands what passes. Anything that genuinely needs a person becomes one inbox item in a local panel; answering it resumes the same worker session. The skill is content plus a zero-dependency Node runtime; the plan is committed, the machine state is not.

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | Skill plus a zero-dep Node runtime, tick-based | Real-time, restarts, and slots need durable state and a loop; a convention-only skill cannot answer "in flight while I sleep", and a full daemon is a product, not a skill |
| 2 | Funnel from idea to merge, planning half thin | Otherwise the skill is `implement-spec` with a dashboard; a complex task arrives as a paragraph |
| 3 | Workers are headless `pi` processes, pi-only, with an adapter seam | Per-run model, live log, slot freed on exit, orchestrator restart does not kill work |
| 4 | Push right; autonomy per campaign; inbox holds only question, review, failure | Attention is the scarce resource; progress reports are noise by construction |
| 5 | Panel is full control | Every panel action has a CLI equivalent, because a control surface that cannot act is a dashboard |
| 6 | State per project plus a console registry | Cross-project inbox is the daily-use feature; cross-machine sync is not |
| 7 | Plan committed at `orchestration/`, runtime gitignored | The plan is the thinking and deserves diffs; runs and logs are noise |
| 8 | Nine ticket stages, each answering "who is it waiting on" | Mutually exclusive and covering, so the panel needs no second status concept |
| 9 | Report is a schema-validated file, never prose | Free-text inference of "it needs a human" is the main source of noise in this class of system |
| 10 | Resume keeps the session | An answer arrives in the context that asked the question, so no re-exploration |
| 11 | One supervisor process for all campaigns | One writer, no locks, one UI; campaign loops stay isolated with their own slots and budgets |
| 12 | Landing is a strategy: branch or directory | Design, visual, and research work does not end in a PR but shares the lifecycle |
| 13 | Gates are checks plus a cold review on a different model | A worker's "ready" is a request for review; a reviewer grading its own work is not a gate |
| 14 | Model binding is a per-kind ordered chain chosen from the live catalog | The first model starts the ticket, each next one is the fallback; the chain is read at claim and the model used is recorded on the run |
| 15 | Ticket kinds are one axis: plan, code, design, visual, research, review, chores | "Which model ran this?" gets one answer, and the setup screen has one section |
| 16 | One approval gate: plan and role table together | Two gates is ceremony; the bindings are part of the plan |
| 17 | The orchestrator may answer from a written source, and must cite it | The biggest lever on inbox volume; the citation is what keeps it honest |
| 18 | User-invoked only | Spawning processes and spending money is never implicit |
| 19 | No vendor, no model, no price in the skill's defaults | A default missing from the machine's catalog is a setup failure disguised as configuration; chains ship empty and approval requires a bound one |
| 20 | A binding may change only while nothing is running | Pause or stop first; a chain that moves under a live ticket makes the ledger's "which model produced this" unanswerable |
| 21 | A delivery that cannot fast-forward merges instead, and `deliver` takes it on demand | The base moves while a campaign runs (a plan commit is enough); refusing would strand a finished campaign behind a race |

## Refinements made while writing

These adjust an earlier answer, and each is deliberate.

- **Ticket status left the frontmatter.** It moves to `state.json` keyed by ticket id. Status changes on every dispatch and every gate; putting them in committed files turns the plan's history into churn. The ledger keeps the real history.
- **The machine layer was dropped.** The console has two levels, console and campaign, because the machine level existed to synchronize across hosts and sync is out of scope. A layer with nothing to do is a bug waiting to happen.
- **"Task type" became "ticket kind".** It is the word the intake form already uses ("Plan tickets", "Code tickets"), and it covers the roles that are not workers.
- **The review gate is a run, not a ticket.** A gate that appears on the board is a ticket in disguise, and it would need its own stage.

## Rejected

| Rejected | Reason |
| --- | --- |
| One supervisor per project plus an aggregating panel | N endpoints, a router, and split-brain, for a restart property nobody needs |
| No integration branch, one PR per ticket | The frontier dispatches against a moving base; main stops being green |
| Inferring "needs a human" from summary text | Silent, unfalsifiable, and it trains the model to hedge |
| A percentage progress bar | A campaign's position is a set of stages, not a scalar |
| Estimating spend | An estimate that is wrong is worse than "unmetered" |
| A database | The ledger plus reports are append-only and greppable; SQLite buys nothing at this scale and breaks `git diff` |
| Bundling matt's skills as dependencies | The skill must work standalone; it borrows the vocabulary (tickets, blockers, frontier, tracer bullets) and the shapes, not the install |

## Build order

Each stage ends when its verification holds. All six are built; `node --test tests/*.test.mjs` runs 83 tests across the YAML subset, the ticket graph, config validation, the engine end to end with a scripted worker, the CLI and the HTTP surface.

1. **Foundation.** `scripts/orchestrate.mjs` with `init`, `catalog`, `status`; console and campaign config load and validate; ticket parser and graph validation (acyclic, every criterion claimed, kinds known); ledger append; state derivation. *Verify:* `node:test` fixtures for a valid plan and eight invalid ones, each refused with the right message.
2. **Tick engine.** Frontier, slots, dispatch of a real `pi` process, report collection, retries, timeouts, stuck detection, restart recovery. *Verify:* a scratch repo with three tickets (one blocked, two parallel) completes unattended, and a killed supervisor resumes once.
3. **Read-only panel.** `/api/state`, `/api/events`, Board, Ticket, Inbox. *Verify:* a running campaign renders live, and a page reload loses nothing.
4. **Writes and judgement.** Command queue, answer and review actions, orchestrator judgement with citations, decisions log. *Verify:* a worker's question is answered from the brief with a citation and never reaches the inbox; a second question without a source does.
5. **Gates and landing.** Checks, review run, branch landing with integration branch and serial merges, directory landing, delivery under each autonomy level and the diff-size override. *Verify:* a failing check sends the ticket to `needs_changes` and the same session fixes it; a conflict parks once and is resolved by a chores run.
6. **Surface and evals.** Campaign form in the panel, `assets/ui` polish, `evals/evals.json` with a fixture campaign, SKILL.md and references re-read against what was built.

## What building it changed

Five things only a real run could teach. Each is fixed in the code and reflected in the references.

1. **A kind that must report needs a tool that can write.** `review` and `plan` shipped with `read,grep,find,ls`, so the reviewer could read the diff perfectly and then had no way to run `report.mjs`. It said so in prose and the run failed. Tool sets now include `bash`, and validation refuses any kind whose tools include neither `bash` nor `write`.
2. **`node --test test/` no longer works.** Node 26 rejects a directory positional; the gate caught it on the first ticket, and the fix was a campaign edit rather than a code change, which is what "checks are data" is for.
3. **The engine's own stage write made the checkout dirty.** Writing `stage: running` into the committed campaign file blocked the fast-forward delivery at the end. Delivery now ignores the campaign's own plan file when it asks whether the checkout is clean.
4. **A gate failure with no captured output must say so.** The resumed worker was handed `check "tests" failed:` and went looking for work that did not exist. An empty findings block now says the gate recorded no detail and tells the worker to run the checks itself.
5. **A command that changes the stage must write it back to the plan.** Pausing updated `state.json` only, so `bind` still saw `running` in the file and refused forever. Pause, resume and approve now write the stage through.

## Proof: a real project

`$HOME/habitlog` is a real repository built entirely by this skill, with real workers and no scripted reports.

- **Plan.** Five tickets over three waves: storage and docs in parallel, then streaks and the CLI's `add`/`list`, then the CLI's `streak` command on top of both. Blockers and `touches` are declared per ticket, so the per-kind cap of 2 and the touch overlap rule decided dispatch order without a human.
- **Binding.** `code` and `chores` on `deepseek-v4.1-flash`, `review` and `plan` on `muse-spark-1.3-contributor`, each with the other as fallback, as the operator required. The run records confirm those are the only two models the campaign used.
- **Run.** `orchestrate run` served the panel and ticked every 2 s. Two work runs at a time, ten runs in total (five work, five review), one run per ticket collected, checks executed by the supervisor.
- **Outcome.** 5 of 5 tickets `done`, 688 lines added across 7 files, 23 tests green on `main`, 145,885 tokens and $0.0013. The delivery filed a review item because 690 changed lines exceeded `max_autoship_lines: 200`, and fast-forwarded into `main` after the human approved it.
- **Proof of behaviour, not just of state.** On `main`: `node --test` is 23 passing, `node src/cli.mjs add gym` prints `added gym 2026-11-09`, `list` prints entries oldest first, `streak` prints `gym: current 1, best 1`, both empty cases print `no entries` and `no streaks`, and an unknown command exits 1 with a message. `package.json` has no dependencies and every import is a `node:` builtin.

Four defects only this run could find, all fixed above: the reviewer had no tool to write its report, the campaign's check used a Node argument form that no longer works, the engine's own stage write made the checkout look dirty at delivery, and an untracked plan directory blocked the merge until `git status -uall` expanded it into files. A fifth case, the base moving mid-campaign, is covered by the merge fallback and a test.

6. **A class name collision made a button a fixed bar.** `.signal` positioned the rail's alert strip and `.btn.signal` coloured a destructive button, so the button inherited `position: fixed; inset: 0 auto 0 0` and rendered as a 26 px sliver at the window edge. The rail is now `.rail-signal`. Two lessons kept here: prefix single-word utility classes by the element they belong to, and probe geometry from the browser rather than trusting a screenshot.

## Second pass (after the ant round)

The remaining-work list was closed in one pass. What changed, and why:

| Area | Change | Reason |
| --- | --- | --- |
| Memory | `decisions.jsonl` is written by the supervisor on every answer and judgement, with a question hash and the ticket's paths | The reader existed and the writer did not: every prompt read a file nothing filled |
| Memory | A repeated question is answered from a decision before any model is asked; a reworded one needs three shared significant words | A retried ticket asks the same thing twice, and the second ask should be a lookup |
| Memory | Decisions supersede on identical question or identical paths, never on overlap; a decision whose paths are gone is retired at delivery | Overlap lets one broad claim erase precise ones; dead paths are stale trails |
| Verification | A `ready` report must show a non-empty diff inside its declared `touches`, and `allow_paths` exists for generated files | The report is free to write; the diff is not |
| Verification | Directory landing snapshots the tree at the ticket's first run and compares each later run against it | With no branch there was no drift check at all |
| Control | `ticket edit`, `ticket remove`, `cancel`, `archive`, in the CLI and the panel | The panel could start work it could not finish or undo |
| Delivery | Ticket worktrees and branches are pruned at delivery; `CLOSE.md` is written | Accepted in the ant round, then unimplemented |
| Panel | Chain picker fed by the live catalog; command errors surface as a toast; cost below a cent shows four decimals; the registry is read per request, so a new project appears without a restart | Every one of these was observed as a defect in use |
| Correctness | Rejecting a delivery no longer merges it; approval requires the `review` kind; a lost `state.json` recovers attempts and spend from the run records | Five defects found by walking the remaining-work list |

Proof added in this pass: a second real campaign in a **different project** with no git (`habit-notes`, directory landing, `research` kind, two tickets) delivered and read end to end, served beside `habitlog` in one panel; and `evals/run.mjs`, which executes the five machine-checkable eval expectations (5 of 5).

## Risks

| Risk | Mitigation |
| --- | --- |
| `touches` overlap is conservative, so it can starve parallelism | Prefix and glob intersection only, never substring; the panel names the lane a ticket waits on, so over-declaring is visible and fixable |
| A resumed session in a recreated worktree loses its bearings | Worktrees persist per ticket until delivery; `--session-dir` is stable and the recovery note names the paths |
| The orchestrator answers a question wrongly | Citation required, the exchange is on the ticket, and the close report lists every self-answered question for audit |
| Provider usage that reports zero makes spend a lie | Display "unmetered" for a run with no usage, and count it in a separate column |
| A worker in a worktree loads the wrong project config | Dispatch sets cwd, session dir, and model explicitly, and stage 2 verifies a worker sees the campaign's reading list |
| Full control widens the blast radius | Bindings are read at claim and recorded on the run; a binding change is refused while anything is live; every write is a queued command with an audit event |

## Out of scope for v1

Non-`pi` harnesses (Codex, Antigravity), cross-machine sync, external sources (GitHub, Feishu, mail), webhooks from outside, per-model quota beyond spend display, auto-merge to a protected base without a human, and a mobile view.

## Open questions for review

None blocking. Two defaults were taken when the earlier questions went unanswered: the panel port is `4173` and steps up to the next free port if taken, and the planning step defers to a `grilling` skill when one is installed, falling back to the capped seven-question round otherwise.
