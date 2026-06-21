---
name: restore-zcode-session
description: Reconstruct the context of a previous ZCode chat session from a log file or session ID, so a fresh session can continue the work. Use when the user says "restore session", "continue previous session", "pick up where we left off", "recover chat", points at a ZCode log path (e.g. /home/hlu/.zcode/cli/log/zcode-2026-06-15.jsonl), or hands over a sess_… ID — even if they don't explicitly ask for restoration. Outputs a reconstructed transcript, an in-progress task summary, and the list of files the previous session touched.
---

# Restore a ZCode chat session

ZCode persists session state in two places, both reachable from a fresh chat:

- **Logs** — newline-delimited JSON at `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`. These are low-level protocol events (`model.request.completed`, `tool.call.started`, …) — they don't contain user prompts, only timestamps and tool names. They are useful for *finding* which session was active and roughly when.
- **SQLite DB** — `~/.zcode/cli/db/db.sqlite`. This is where the actual conversation lives: `session`, `message`, and `part` tables hold roles, text, tool calls, and their inputs/outputs.

When a chat session dies, breaks, or the user wants to start a new chat and continue, restore from these. The DB is the source of truth; the log is just a pointer.

## Inputs

The user may give any of:

- A log file path (e.g. `/home/hlu/.zcode/cli/log/zcode-2026-06-15.jsonl`)
- A session ID (`sess_<uuid>` from the DB)
- Nothing — default to the most recently updated session in the DB

If the user gives a log file, use it to find the most recent `traceId`, then locate the matching session row in the DB by `trace_id` or by `time_updated` window. The exact matching strategy is in `scripts/restore.py`.

## Workflow

1. **Resolve the target session.** Use the wrapper at the skill root:
   ```
   <skill-dir>/restore-zcode-session resolve <input>
   ```
   It accepts a log path, a `sess_…` ID, or the literal string `latest`. It prints `<sess_id>\t<workspace>\t<title>`. The wrapper auto-locates `scripts/restore.py` so it works from any CWD and after copying the skill anywhere.
2. **Dump the session content.** Use the same wrapper:
   ```
   <skill-dir>/restore-zcode-session dump <sess_id> --max-messages 30
   ```
   The script handles joining `message` and `part` rows, role filtering, and chronological ordering. It prints:
   - A summary header (title, workspace, time range, message count)
   - Each message as `=== [timestamp] role (msg_id_short) ===` followed by `TEXT:` / `TOOL <name>:` / `REASON:` lines
3. **Read the transcript the wrapper produced.** Don't re-query the DB by hand — the script already filters the noise (step-start, step-finish, system reminders, empty messages).
4. **Extract the three things the user needs** (see "Output" below).
5. **Hand the summary back to the user** in chat. Offer to start the next step.

If you don't know where the skill is installed, you can also call `python3 <skill-dir>/scripts/restore.py …` directly — the wrapper is a thin convenience layer. To find the skill dir, look in this order:
- `<cwd>/.agents/skills/restore-zcode-session/`
- `<cwd>/.zcode/skills/restore-zcode-session/`
- `~/.agents/skills/restore-zcode-session/`
- `~/.zcode/skills/restore-zcode-session/`

The first one that exists wins.

## Output

Always produce these three blocks, in this order:

### 1. Reconstructed transcript
Concise, not raw. Drop `step-start`/`step-finish`/`<system-reminder>` noise. Group rapid back-and-forth into a narrative ("assistant read `performance.ts`, wrote `e2e_per_render.mjs`, ran it — render-phase had 0 blocks >10ms but commit gaps were 300-1300ms apart"). Keep verbatim quotes only for user prompts and decisive assistant conclusions. If the transcript is huge (200+ messages), produce an overview of the first half and full detail of the last 20–30 messages.

### 2. In-progress task summary
A 2-4 line statement of:
- What the user was trying to do
- What the assistant had figured out so far
- The single next concrete step

Pull this from the **last user prompt** and the **last few assistant actions**. If the assistant was mid-tool-call when the session died, say so explicitly.

### 3. Files touched
A bullet list of every file the previous session read, wrote, or edited. Group by read / write. If a file was written but never committed (still untracked in `git status`), flag it — the user almost certainly wants to know.

## Notes for the model

- **The log file alone is not enough.** It will mislead you: those entries are telemetry, not the conversation. Always cross-reference with the DB.
- **Use the wrapper, not the script directly.** The `restore-zcode-session` wrapper at the skill root auto-locates the Python script and works from any CWD. If you can't find it, search the four standard install locations listed above.
- **Don't read the log first.** Call the wrapper — it's faster, deterministic, and formats the output the way you want it.
- **If the script fails, run `self-test`.** It's a built-in smoke test that tells you whether the install is broken vs whether the user's input is wrong. The output is short — read it before guessing.
- **Don't try to "continue" the work yourself yet.** The user asked to restore context, not to start fixing the bug. Ask whether they want you to pick up the next step or just stand by.
- **The DB can be locked.** If you get `database is locked`, retry once; if it persists, suggest the user close the running ZCode process. The DB is at `~/.zcode/cli/db/db.sqlite`.
- **Schema details** (tables, column names, role-vs-type quirks) are in `references/storage-layout.md` if you need to extend the script.

## Bundled files

- `restore-zcode-session` — bash wrapper; the entry point you should use
- `scripts/restore.py` — does the DB work. The wrapper just execs this.
- `references/storage-layout.md` — DB schema notes for maintainers.
- `README.md` — quickstart for humans or agents that land in this directory first.


## Bundled files

- `scripts/restore.py` — does the DB work. Invoke it; don't re-implement.
- `references/storage-layout.md` — DB schema notes for maintainers.
