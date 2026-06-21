# restore-zcode-session

Self-contained skill for picking up a ZCode chat session that broke, died, or
just needs to move to a new chat. Reads from ZCode's local SQLite DB
(`~/.zcode/cli/db/db.sqlite`); falls back to log files when the DB doesn't have
a matching session.

## Quickstart (human or agent)

```bash
# Restore the most recent session:
./restore-zcode-session resolve latest
./restore-zcode-session dump sess_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Or pipe the resolve into dump in one shot:
SID=$(./restore-zcode-session resolve latest | cut -f1)
./restore-zcode-session dump "$SID" --max-messages 30

# Just the files the session touched (handy for "what did it change?"):
./restore-zcode-session files "$SID"

# Smoke-test the install:
./restore-zcode-session self-test
```

The wrapper (`./restore-zcode-session`) auto-locates `scripts/restore.py`, so
it works from any CWD and after copying the directory anywhere. It accepts the
same args as the Python script.

## Inputs the `resolve` subcommand accepts

| input | meaning |
| --- | --- |
| `latest` | the most recently updated session in the DB (default-ish) |
| `sess_<uuid>` | a session id you already have |
| `/path/to/zcode-YYYY-MM-DD.jsonl` | a log file; the most recent `traceId` in it is matched to a session |

## What you get back

`dump` prints:

- a 5-line session header (id, title, workspace, time range, message count)
- the last N messages as `=== [ts] role (msg_id) ===` blocks
- each block contains `TEXT:`, `TOOL <name>:`, or `REASON:` lines
- system reminders and step markers are filtered out by default

`files` prints the unique file paths grouped by `WRITE` / `EDIT` / `READ`.

## Files in this skill

```
restore-zcode-session/
├── SKILL.md                    # how the agent uses this skill
├── restore-zcode-session       # bash wrapper (entry point)
├── scripts/
│   └── restore.py              # the actual logic
└── references/
    └── storage-layout.md       # DB schema notes
```

The skill is dependency-free (Python stdlib only). Copy the whole directory
anywhere and the wrapper still works.

## Troubleshooting

- **`DB not found at …`** — your ZCode install isn't at the standard location. Pass `--db /path/to/db.sqlite` to the wrapper.
- **`Session sess_… not found`** — the session id is wrong, or the DB was compacted. Try `./restore-zcode-session resolve latest` instead.
- **`database is locked`** — the running ZCode process holds the DB. Close it and retry.
- **`No traceId found in …`** — the log file is empty or malformed. Pass a session id directly.
