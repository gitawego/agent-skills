# ZCode session storage layout

Notes for anyone extending `scripts/restore.py`. Schema can drift between ZCode versions; if a column disappears, this is the first place to look.

## Locations

- **DB:** `~/.zcode/cli/db/db.sqlite` (override with `--db`).
- **Logs:** `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`. Newline-delimited JSON; one event per line. Log entries are protocol telemetry, not conversation content. They are useful only for finding which `traceId` was active at a given time.

## Tables

### `session`
One row per chat session. The interesting columns:

| column | type | notes |
| --- | --- | --- |
| `id` | text PK | `sess_<uuid>` |
| `title` | text | auto-generated from first user input (see `title_source`) |
| `directory` | text | absolute path of the workspace when the session started |
| `time_created` | int | unix ms |
| `time_updated` | int | unix ms — sort on this to find the latest |
| `trace_id` | text | matches the `traceId` field in log entries. May be NULL on older sessions. |
| `task_type` | text | `'interactive'` for normal chats, other values for headless tasks |
| `parent_id` | text | parent session if this was a sub-task / fork |
| `time_archived` | int | non-NULL once archived |

### `message`
One row per chat turn (user or assistant). Stored as a JSON blob in `data`:

```json
{
  "role": "user" | "assistant",
  "time": { "created": 1781508666658 },
  "parentID": "msg_…",
  "modelID": "…",
  "agent": "zcode-agent",
  "path": { "cwd": "/…", "root": "/…" }
}
```

The actual content of a message lives in the `part` table — `message.data` is just metadata.

### `part`
One row per content chunk of a message. `type` is the discriminator:

| `type` | shape | meaning |
| --- | --- | --- |
| `text` | `{type, text, time}` | free text — user prompt or assistant prose |
| `tool` | `{type, tool, state, input, output, time}` | a tool call. `state` is `'pending' \| 'running' \| 'completed' \| 'error'`. The actual inputs are in `state.input` (preferred) or top-level `input`. Outputs are in `state.output`. |
| `reasoning` | `{type, text, summary}` | chain-of-thought from reasoning models (often empty for non-reasoning models) |
| `step-start` | `{type}` | protocol marker; safe to skip |
| `step-finish` | `{type, reason, cost, tokens}` | protocol marker; safe to skip |

User prompts are `text` parts whose parent `message.data.role === 'user'`. The most reliable way to filter is to join on the message table once and look up `role` there.

## Why this layout is awkward

The DB normalises poorly. Each message has multiple parts (text + tool + tool output + step markers), and the `tool` part's input lives under `state.input` for live sessions but at the top level for completed sessions. The script handles both. If you add new fields, keep the same `state || <top>` fallback pattern.

## Known quirks

- `time_updated` is wall-clock-ish, not strictly monotonic. Two sessions started in the same second can have the same `time_updated`; tie-break on `id`.
- Some sessions in the DB are not in the log, and vice versa. The script falls back to "latest session overall" when a log's `traceId` has no matching row.
- Old sessions (pre 0.14.x) may not have `trace_id` populated. Use `time_updated` for those.
- The `message.data` blob can grow large; reading it for every row in a join is fine for one session, expensive for a scan.
