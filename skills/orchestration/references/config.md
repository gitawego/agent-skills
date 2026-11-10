# Config

Two files hold configuration. The **console** holds defaults for every project on this machine. A **campaign** holds the one setup a human needs before dispatch. The console's settings apply to a campaign unless the campaign changes them.

## The console

`~/.config/orchestration/console.json`, written by `init` and editable in the panel's Settings screen.

```json
{
  "version": 1,
  "panel": { "port": 4173, "bind": "127.0.0.1" },
  "limits": {
    "max_concurrent": 4,
    "run_timeout_min": 90,
    "stuck_after_min": 10,
    "max_attempts": 3,
    "human_slot_extra": 1
  },
  "runner": { "command": "pi" },
  "quotas": [
    { "provider": "opencode-go", "adapter": "opencode-acp", "window": "5h",
      "used": 72, "limit": 100, "resetAt": "2026-11-10T15:00:00Z",
      "source": "manual", "updatedAt": "2026-11-10T12:00:00Z" }
  ],
  "kinds": {
    "plan":     { "label": "Plan",     "description": "Planning, decomposition, judging escalations",
                  "models": [],
                  "max_concurrent": 1, "tools": "read,grep,find,ls,bash", "timeout_min": 30 },
    "code":     { "label": "Code",     "description": "Backend, tests, code, frontend matching existing style",
                  "models": [],
                  "max_concurrent": 2, "tools": "default", "timeout_min": 90 },
    "design":   { "label": "Design",   "description": "Layout, typography, motion, new frontend design",
                  "models": [],
                  "max_concurrent": 1, "tools": "default", "timeout_min": 90 },
    "visual":   { "label": "Visual",   "description": "3D, material, rendering, visual adjudication",
                  "models": [],
                  "max_concurrent": 1, "tools": "default", "timeout_min": 120 },
    "research": { "label": "Research", "description": "Exploration, reading, batching, docs, purely offline verification",
                  "models": [],
                  "max_concurrent": 3, "tools": "read,grep,find,ls,bash,web_search,fetch_content", "timeout_min": 60 },
    "review":   { "label": "Review",   "description": "Cold review of a diff against the ticket and the standards",
                  "models": [],
                  "max_concurrent": 1, "tools": "read,grep,find,ls,bash", "timeout_min": 45 },
    "chores":   { "label": "Chores",   "description": "Merges, disk cleanup, ops, read-only investigation",
                  "models": [],
                  "max_concurrent": 2, "tools": "default", "timeout_min": 30 }
  }
}
```

A kind that reports (every kind does) needs a tool that can write `report.json`: `bash` or `write`. A tool set without either is refused at validation, because a reviewer that cannot report can only fail.

`runner.command` is the pi executable override; it stays `pi` unless a test or another harness needs to stand in. The adapter seam is `runner.adapter`: `pi`, `agy-acp` (Antigravity), or `opencode-acp`. A campaign may override the console's adapter in its frontmatter:

```yaml
runner:
  adapter: opencode-acp
  spend: subscription-only
  sandbox: auto
```

`spend` is `subscription-only` or `metered-ok`. Subscription-only hides models the plan does not include and refuses a binding to them; metered-ok shows every discovered model with its price. Antigravity and OpenCode Go default to subscription-only; pi defaults to metered-ok. The campaign's adapter is fixed while it runs, for the same reason a chain is.

`sandbox` is `auto`, `bwrap` or `none`. On Linux, auto wraps the worker in `bwrap` when available: `/` is read-only, and only the worktree, run directory, temp directory and harness state directories are writable. Network stays shared because the worker must reach its model API. Other platforms fall back to the path-based permission guard.

### Provider quotas

A quota window is a scheduling constraint, not a bill. Each entry names a provider, optionally an adapter, a window label, the amount used against a limit, an optional reset time, and where the observation came from:

```json
{
  "provider": "opencode-go",
  "adapter": "opencode-acp",
  "window": "5h",
  "used": 72,
  "limit": 100,
  "resetAt": "2026-11-10T15:00:00Z",
  "source": "manual",
  "updatedAt": "2026-11-10T12:00:00Z",
  "staleAfterMin": 1440
}
```

- `provider` matches the model's provider (`opencode-go`, `antigravity`, `anthropic`, …). `adapter` is optional and matches the adapter id. When both are set, both must match; when only one is set, that one decides. This lets one entry cover a whole subscription or one provider inside an adapter.
- `used` and `limit` are the same unit, usually a percentage. An entry blocks dispatch when `used >= limit` and its reset is still ahead.
- `resetAt` in the past clears the window. A missing reset keeps the block until edited.
- `source` is `manual`, `api` or `stale`. `stale` is always drawn as stale. Any entry older than `staleAfterMin` (default 1440) is also stale.
- Stale entries are never enforced: they are shown with a dashed border and a warning, but dispatch proceeds. Only fresh, exhausted windows block.

A campaign's `quotas` list is merged over the console's: the same `provider` + `adapter` + `window` replaces, a new key adds. `orchestrate quota set` writes the console entry; the panel's Settings and Campaign screens edit the same shape.

The console-wide dispatch switch lives outside any project at `~/.local/state/orchestration/dispatch.json`:

```json
{ "version": 1, "mode": "paused", "reason": "quota exhausted", "at": "2026-11-10T12:30:00Z", "by": "panel" }
```

`mode: paused` stops new claims in every campaign; live runs and their gates finish. A pause requires a reason. `orchestrate dispatch pause --reason "..."`, `dispatch resume`, or the top-bar switch writes it.

ACP permission requests are mediated by the client: a tool call naming a path outside the worktree or the system temp directory is denied, and the decision is written to `permissions.jsonl`. Commands are checked for absolute-path escapes; the bwrap sandbox above is the enforcement layer, while this remains a second guard.

Every adapter writes a snapshot to `~/.local/state/orchestration/catalogs/<adapter>.json`; `bind`/`approve` also write a project-scoped snapshot, because OpenCode's model list depends on the project. The panel reads the latest projection and marks it stale after an hour; `bind`/`approve` always refresh live. `orchestrate doctor` reports missing harnesses, empty catalogs and stale snapshots. ACP discovery creates and closes one session, so it costs seconds, not tokens.

ACP does not list per-model context windows or modalities. Antigravity advertises image input at the server level, so Gemini and Claude rows are marked as image-capable, GPT-OSS is marked text-only, and an unknown family stays `null`; OpenCode rows get modalities and prices from the local model store. `null` means "not proven", not "no", and a `visual` chain is refused until the model is known to read images.

The `kinds` block is the role table. Worker roles and the roles that judge, review, and merge are all ticket kinds, one axis, so "which model ran this?" has exactly one answer. Each kind also has a role contract under `references/roles/`, appended to that run's system prompt after the standing `contract.md`; a custom kind with no file of its own gets `roles/general.md`.

A chain entry may override the campaign's adapter: `{ adapter: agy-acp, model: antigravity/gemini-4-argon, thinking: medium }`. That is how a campaign runs code on pi and design or review on Antigravity in the same plan. The campaign-level `runner.adapter` is the default for entries that omit it.

The chains ship **empty**. This skill names no vendor and no model, because a default that is not installed on the machine is a setup failure wearing a config's clothes. Binding is a step, not a default.

A **chain** is ordered. The first model starts the ticket; each next one is the fallback. A fallback is used only when the previous model is unusable: no credentials, a model missing from the catalog, a provider failure that survives the retries, or a per-model budget guard. The attempt that used it is recorded on the run.

## Binding

`node scripts/orchestrate.mjs catalog` prints the live catalog: provider, model, context window, max output, whether it thinks, whether it sees images, and the price per 1M tokens when the adapter's model store knows it. There is no quality ranking in it, so binding is a judgement, not a lookup: read the table, match the model to the kind of work, and say why in one line. Rows are ordered by a blended list price (input weighted 4:1 over output), free first and unknown price last; that is an ordering, not an automatic choice.

Rules of thumb, not policy:

- the first model matches the kind: code and review want the strongest reasoning the catalog has, chores and research tolerate a fast one;
- the fallback comes from a different provider when one exists, because same-provider fallbacks share their outages;
- `visual` needs image support; `review` gains nothing from a model that cannot read images in a diff;
- thinking levels are clamped by the model, so a model without thinking support simply ignores the level.

Binding happens in one of three places, all writing the same value: the panel's chain picker on the Settings or Campaign screen (fed by the live catalog, so a model that is not installed cannot be chosen), `bind` on the CLI, or the file itself while the supervisor is stopped.

A binding may change at any time while nothing is running: stop the supervisor, or pause the campaign and let its live runs finish. A save while the campaign is `running` or one of its runs is live is refused, naming the run, because a chain that changes under a working ticket turns "which model produced this?" into a guess. Each run records the model it used regardless, so the ledger stays answerable after the change.

## The campaign

`orchestration/<campaign>/campaign.md` is committed: the plan deserves diffs and history. Frontmatter holds config; the body holds the work.

```markdown
---
campaign: pocket-museum-v4
stage: running
autonomy: supervised          # supervised | trusted | unattended
plan_gate: human              # human | auto
landing: branch               # branch | directory
base: main                    # branch-landing only
checks:
  - { name: typecheck, cmd: "npm run -s typecheck" }
  - { name: tests, cmd: "npm run -s test -- --run" }
budget: { tokens: 2000000, dollars: 40 }   # either may be null; null inherits the console
max_autoship_lines: 200
quotas:                       # optional additions or overrides of the console windows
  - { provider: antigravity, adapter: agy-acp, window: weekly, used: 0, limit: 100, resetAt: "2026-11-17T00:00:00Z", source: manual }
kinds:                        # sparse: only what this campaign changes
  code:
    models: [{ model: "<provider/model>", thinking: "high" }, { model: "<provider/model>", thinking: "medium" }]
    max_concurrent: 3
  review:
    models: [{ model: "<provider/model>", thinking: "high" }]
---

## Goal

One sentence. What is true when this campaign is done.

## Brief

Why this exists, what came before, what the shape of the answer is. Keep it to what a worker could not learn by reading the repo.

## Acceptance criteria

- [ ] Criteria for the campaign as a whole, each checkable by a person or a command.

## Constraints

What must not change, what must stay compatible, house style, deadlines, frozen surfaces.

## What to read first

- **Files:** `src/app/router.ts`, `docs/architecture.md`
- **Material:** the 2026-11-03 interview notes
- **Links:** https://example.com/spec

Empty is allowed: the plan then decides what is worth reading.
```

The campaign form mirrors the intake a human already fills for a new orchestration: goal first and required, then brief, acceptance criteria, and constraints, then what to read first, then budget and the per-kind model chains. Nothing else is asked at start.

### Fields

| Field | Meaning |
| --- | --- |
| `stage` | `draft`, `awaiting_approval`, `running`, `paused`, `delivered`, `archived`. Runtime-written; the panel shows it, only the supervisor sets it |
| `autonomy` | `supervised` leaves every delivery to a human; `trusted` lands small verified work and escalates the rest; `unattended` lands everything that passes its gates and files only questions and failures |
| `plan_gate` | `human` waits for approval; `auto` dispatches on a finished plan and files it as a review item (only meaningful with `unattended`) |
| `landing` | `branch` uses worktrees, an integration branch, and one result to merge; `directory` writes artifacts into a workspace with no branches |
| `base` | The ref a branch-landing campaign branches from and merges back into |
| `checks` | Deterministic commands the supervisor runs itself in the ticket's worktree. A worker's own check claims are ignored |
| `allow_paths` | Globs that never count as drift: lockfiles, snapshots, generated files a worker regenerates without declaring them |
| `budget` | Campaign-wide ceiling in tokens and dollars; either may be null. The supervisor meters from the `usage` of each run's JSON log and pauses the campaign on exhaustion. `ack_unmetered: true` is required when a dollar ceiling is combined with a subscription adapter, because those runs report tokens but no dollar cost. |
| `max_autoship_lines` | Additions plus deletions above which a delivery never ships without a human, whatever the autonomy level |
| `quotas` | Optional provider windows layered over the console's. Same provider/adapter/window overrides; a fresh exhausted window holds the matching models |
| `kinds` | Sparse overrides of the console's kinds: model chains may be replaced, caps and timeouts may only be tightened |

### Inheritance

The console is the default; the campaign may tighten. Concurrency, timeout, and budget may only go down or stay equal as the setting moves from console to campaign. Model chains may be replaced outright, because the right model for a design ticket is a per-campaign judgement. There is no machine layer in v1: cross-machine sync is out of scope, so a middle layer would have nothing to synchronize.

### Validation

Binding is refused, with the offending value named, when:

- a model in a chain is absent from the campaign adapter's catalog (offer `catalog --refresh`);
- a chain is empty, for any kind the plan uses;
- the write lands while the campaign is `running` or a run is live;
- a cap exceeds the console's cap;
- a budget exceeds the console's, or both budget units are null while the console sets one;
- `landing: branch` and `base` does not exist, or the campaign root is not a git repository;
- a check command is empty.

Refusal happens at approval, not at dispatch: a plan is never approved against a binding that cannot run.

## Tickets

`orchestration/<campaign>/tickets/<NN>-<slug>.md`. The number is the order; the name is stable and is what the panel and the inbox address. A ticket declares the plan, never its runtime status, which lives in state so that dispatching does not dirty git.

```markdown
---
id: 03
kind: design
blocked_by: [01, 02]
touches: ["src/api/**", "src/db/migrations/**"]
attachments: ["refs/shelf.png"]
---

## What to build

The end-to-end behaviour this ticket makes work, from the user's point of view.
No layer-by-layer list, no file paths that will go stale.

## Acceptance criteria

- [ ] A checkable outcome a cold reviewer can confirm from the diff.

## Notes

Only what the worker cannot infer: a pointer to a prototype, a decision already made, a trap.
```

Rules:

- **Vertical slice.** Each ticket cuts a complete path, and is demoable or verifiable alone.
- **One context window.** If a competent worker cannot finish it in one session, split it.
- **Blockers are real edges.** A ticket with no blockers can start immediately. A cycle is a planning error and fails validation.
- **`touches` is a promise about blast radius.** Globs that the ticket will modify. The scheduler refuses to run two tickets whose `touches` can overlap, so parallelism never manufactures a merge conflict. Over-declaring costs throughput; under-declaring costs a parked ticket.
- **`kind` picks the model chain.** The planner sets it; a human may override it in the panel before approval.
- **`attachments` carries images and PDFs.** Paths are relative to the project, must be png/jpeg/webp/gif/pdf and inside the project. The supervisor sends images as ACP image blocks and PDFs as embedded resource blocks (and both as `@file` context to pi); the run records their hashes, never the payload. A model that cannot read the attachment kind is refused at dispatch (the next capable model in the chain is tried first). Images above 512 KB are downscaled to a 1600 px long edge and WebP when ImageMagick is available.
- **Editing keeps the file.** `ticket edit` rewrites the heading, frontmatter and body in place: the filename is the ticket's address, and renaming it would churn history for no gain. A ticket can be removed once nothing is blocked by it.

## Spend

Every run's JSON log ends with cumulative `usage`, including `totalTokens` and `cost.total`. The catalog carries no price, so a budget in dollars can only be checked against what providers actually report; a model that reports nothing is shown as unmetered rather than free. The supervisor sums per run, per ticket, per campaign, and per model, and writes the result to the ledger. Spend is always displayed. Budget is a ceiling, not a default: without one, an unattended campaign is never silently capped, and the panel can still show that a campaign has cost more than the last three combined.
