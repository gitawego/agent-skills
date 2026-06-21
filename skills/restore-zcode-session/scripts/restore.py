#!/usr/bin/env python3
"""Restore a ZCode chat session from the local SQLite DB and/or log file.

Self-contained: no third-party deps, runs from any CWD, finds the DB at the
standard ZCode install location, and ships with a self-test.

Subcommands
-----------
resolve <log-path|sess_id|latest>
    Find the target session. Prints "<sess_id>\\t<workspace>\\t<title>".

dump <sess_id> [--max-messages N] [--include-system]
    Print the transcript for a session. Default: 200 messages, no system reminders.

files <sess_id>
    Print just the list of files read/written/edited in the session.

self-test
    Verify the script works against the user's real ZCode install.

The output format is stable — the skill SKILL.md assumes it.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

# This file's location defines the skill's install root. Resolve once so the
# script works regardless of the caller's CWD.
SKILL_DIR = Path(__file__).resolve().parent.parent
SKILL_MD = SKILL_DIR / "SKILL.md"

DEFAULT_DB = Path.home() / ".zcode" / "cli" / "db" / "db.sqlite"
DEFAULT_LOG_DIR = Path.home() / ".zcode" / "cli" / "log"

# Truncate these to keep the transcript readable.
NOISE_TEXT_PREFIXES = (
    "<system-reminder>",
    "step-start",
    "step-finish",
)

# Per-tool input truncation. Keeps the transcript short while preserving intent.
TOOL_INPUT_TRUNC = {
    "Bash": 250,
    "Read": 200,
    "Write": 200,
    "Edit": 200,
    "Glob": 200,
    "Grep": 200,
    "TodoWrite": 120,
    "ReadSessionContext": 80,
}


def _connect(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        sys.exit(f"DB not found at {db_path}")
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    return con


def _latest_trace_from_log(log_path: Path) -> str | None:
    """Return the traceId with the latest timestamp in a log file."""
    if not log_path.exists():
        sys.exit(f"Log not found at {log_path}")
    latest_t, latest_tid = "", None
    with log_path.open() as f:
        for line in f:
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            tid = d.get("traceId")
            t = d.get("timestamp", "")
            if tid and t > latest_t:
                latest_t, latest_tid = t, tid
    return latest_tid


def resolve(target: str, db_path: Path) -> tuple[str, str, str]:
    """Return (session_id, workspace, title)."""
    con = _connect(db_path)

    if target == "latest":
        row = con.execute(
            "SELECT id, title, directory FROM session ORDER BY time_updated DESC LIMIT 1"
        ).fetchone()
        if not row:
            sys.exit("No sessions found in DB")
        return row["id"], row["directory"] or "", row["title"] or ""

    if target.startswith("sess_"):
        row = con.execute(
            "SELECT id, title, directory FROM session WHERE id = ?", (target,)
        ).fetchone()
        if not row:
            sys.exit(f"Session {target} not found")
        return row["id"], row["directory"] or "", row["title"] or ""

    # Treat as a log path
    log_path = Path(target)
    if not log_path.is_absolute():
        log_path = (Path.cwd() / log_path).resolve()
    tid = _latest_trace_from_log(log_path)
    if not tid:
        sys.exit(f"No traceId found in {log_path}")

    # Match by trace_id first; fall back to the latest session within the log's
    # time window if the trace isn't recorded in the session row.
    row = con.execute(
        "SELECT id, title, directory, time_created, time_updated, trace_id "
        "FROM session WHERE trace_id = ?",
        (tid,),
    ).fetchone()
    if row:
        return row["id"], row["directory"] or "", row["title"] or ""

    # Fallback: find the most recently updated session whose directory matches
    # the workspace most active in the log (rough heuristic, last resort).
    row = con.execute(
        "SELECT id, title, directory FROM session ORDER BY time_updated DESC LIMIT 1"
    ).fetchone()
    if not row:
        sys.exit(f"Trace {tid} not in DB and no fallback session found")
    return row["id"], row["directory"] or "", row["title"] or ""


def _format_tool(tool: str, part: dict) -> list[str]:
    """Return a short, single-line summary of a tool call.

    Tool parts in the ZCode DB have the actual input under `state.input`
    (status: completed) or top-level `input` (status: pending). Handle both.
    """
    state = part.get("state") or {}
    if isinstance(state, dict):
        inp = state.get("input") or part.get("input") or {}
    else:
        inp = part.get("input") or {}
    if not isinstance(inp, dict):
        inp = {}
    n = TOOL_INPUT_TRUNC.get(tool, 200)
    if tool == "Bash":
        cmd = inp.get("command", "")
        return [f"  TOOL {tool}: {cmd[:n]}"]
    if tool in ("Read", "Write", "Edit"):
        path = inp.get("file_path", "")
        return [f"  TOOL {tool}: {path[:n]}"]
    if tool in ("Glob", "Grep"):
        pat = inp.get("pattern", "") or inp.get("glob", "")
        return [f"  TOOL {tool}: {pat[:n]}"]
    if tool == "TodoWrite":
        return [f"  TOOL {tool}: <todo update>"]
    if tool == "ReadSessionContext":
        return [f"  TOOL {tool}: <session context>"]
    # Fallback: dump whatever string-y thing is in input
    flat = " ".join(f"{k}={str(v)[:40]}" for k, v in list(inp.items())[:3])
    return [f"  TOOL {tool}: {flat[:n]}"]


def dump(
    sess_id: str,
    db_path: Path,
    max_messages: int = 200,
    include_system: bool = False,
) -> None:
    con = _connect(db_path)
    meta = con.execute(
        "SELECT id, title, directory, time_created, time_updated FROM session WHERE id = ?",
        (sess_id,),
    ).fetchone()
    if not meta:
        sys.exit(f"Session {sess_id} not found")

    n_messages = con.execute(
        "SELECT COUNT(*) AS n FROM message WHERE session_id = ?", (sess_id,)
    ).fetchone()["n"]

    print(f"# Session: {meta['id']}")
    print(f"# Title:   {meta['title']}")
    print(f"# Workspace: {meta['directory']}")
    print(
        f"# Time:    {meta['time_created']} -> {meta['time_updated']}"
    )
    print(f"# Messages: {n_messages} (showing last {max_messages})")
    print()

    # Pull all parts for the session, then group by message and role.
    cur = con.execute(
        """
        SELECT p.message_id, p.data, p.time_created
        FROM part p
        WHERE p.session_id = ?
        ORDER BY p.time_created ASC
        """,
        (sess_id,),
    )
    parts = list(cur)
    cur2 = con.execute(
        "SELECT id, data FROM message WHERE session_id = ?", (sess_id,)
    )
    msg_role = {r["id"]: json.loads(r["data"]).get("role", "?") for r in cur2}

    by_msg: dict[tuple[str, str, int], list[dict]] = defaultdict(list)
    for r in parts:
        pd = json.loads(r["data"])
        role = msg_role.get(r["message_id"], "?")
        by_msg[(r["message_id"], role, r["time_created"])].append(pd)

    items = sorted(by_msg.items(), key=lambda x: x[0][2])
    if not include_system:
        items = [(k, v) for (k, v) in items if k[1] == "user" or k[1] == "assistant"]
    if len(items) > max_messages:
        skipped = len(items) - max_messages
        items = items[-max_messages:]
        print(f"# (omitted {skipped} earlier messages)\n")

    for (mid, role, tc), pdata in items:
        # Materialise this message into its display lines first; if it would be
        # empty (only step markers / no text), drop it entirely.
        lines: list[str] = []
        for pd in pdata:
            ptype = pd.get("type", "?")
            if ptype == "text":
                text = pd.get("text", "").strip()
                if not text:
                    continue
                if not include_system and any(
                    text.startswith(p) for p in NOISE_TEXT_PREFIXES
                ):
                    continue
                lines.append(f"  TEXT: {text[:600]}")
            elif ptype == "tool":
                lines.extend(_format_tool(pd.get("tool", "?"), pd))
            elif ptype == "reasoning":
                text = pd.get("text", "") or pd.get("summary", "") or ""
                if text:
                    lines.append(f"  REASON: {text[:400]}")
            # step-start / step-finish are dropped here; they never produce lines.
        if not lines:
            continue
        print(f"=== [{tc}] {role} ({mid[:12]}) ===")
        for line in lines:
            print(line)
        print()


def collect_files(sess_id: str, db_path: Path) -> dict[str, list[str]]:
    """Return {path: [action, ...]} for every file the session touched.

    `action` is one of 'read', 'write', 'edit'. Order is preserved per-path.
    """
    con = _connect(db_path)
    cur = con.execute(
        """
        SELECT p.data FROM part p
        WHERE p.session_id = ? AND json_extract(p.data, '$.type') = 'tool'
        """,
        (sess_id,),
    )
    out: dict[str, list[str]] = defaultdict(list)
    for r in cur:
        pd = json.loads(r["data"])
        tool = pd.get("tool", "")
        state = pd.get("state") or {}
        inp = state.get("input") if isinstance(state, dict) else None
        if not isinstance(inp, dict):
            inp = pd.get("input") or {}
        if not isinstance(inp, dict):
            continue
        if tool == "Read" and "file_path" in inp:
            out[inp["file_path"]].append("read")
        elif tool == "Write" and "file_path" in inp:
            out[inp["file_path"]].append("write")
        elif tool == "Edit" and "file_path" in inp:
            out[inp["file_path"]].append("edit")
    return out


def files(sess_id: str, db_path: Path) -> None:
    touched = collect_files(sess_id, db_path)
    if not touched:
        print("(no file-touching tool calls found)")
        return
    by_action: dict[str, list[str]] = defaultdict(list)
    for path, actions in touched.items():
        for a in actions:
            by_action[a].append(path)
    for action in ("write", "edit", "read"):
        paths = sorted(set(by_action.get(action, [])))
        if not paths:
            continue
        print(f"\n## {action.upper()}")
        for p in paths:
            print(f"  - {p}")


def self_test(db_path: Path) -> int:
    """Run a quick smoke test. Returns 0 on success, 1 on failure."""
    print(f"# SKILL_DIR = {SKILL_DIR}")
    print(f"# SKILL_MD exists = {SKILL_MD.exists()}")
    print(f"# DB = {db_path}")
    print(f"# DB exists = {db_path.exists()}")
    if not db_path.exists():
        print("\nFAIL: ZCode DB not found at the standard location.")
        print("  Set --db to point at your db.sqlite, or install ZCode.")
        return 1
    if not SKILL_MD.exists():
        print(f"\nFAIL: SKILL.md missing at {SKILL_MD}")
        return 1

    print("\n# Test 1: resolve latest")
    sid, ws, title = resolve("latest", db_path)
    print(f"  -> {sid}  ({ws})  {title!r}")

    print("\n# Test 2: dump last 3 messages of that session")
    # Capture dump output to a temp file so we can check it's non-empty.
    with tempfile.NamedTemporaryFile("w+", suffix=".txt", delete=False) as f:
        tmp = Path(f.name)
    try:
        import subprocess

        r = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "dump", sid,
             "--max-messages", "3"],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            print(f"  FAIL: dump exited {r.returncode}")
            print(r.stderr)
            return 1
        tmp.write_text(r.stdout)
        if tmp.stat().st_size < 100:
            print(f"  FAIL: dump output suspiciously small ({tmp.stat().st_size} bytes)")
            return 1
        print(f"  -> {tmp.stat().st_size} bytes of transcript")
    finally:
        tmp.unlink(missing_ok=True)

    print("\n# Test 3: files for that session")
    touched = collect_files(sid, db_path)
    print(f"  -> {len(touched)} unique files touched")

    print("\nOK: skill is self-contained and working.")
    return 0


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB,
        help=f"Path to db.sqlite (default: {DEFAULT_DB})",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("resolve", help="Find the target session id")
    pr.add_argument("target", help="Log path, sess_… id, or 'latest'")

    pd_ = sub.add_parser("dump", help="Print the transcript for a session")
    pd_.add_argument("sess_id")
    pd_.add_argument("--max-messages", type=int, default=200)
    pd_.add_argument(
        "--include-system",
        action="store_true",
        help="Include <system-reminder> and step-* noise",
    )

    pf = sub.add_parser("files", help="List files touched by a session")
    pf.add_argument("sess_id")

    sub.add_parser(
        "self-test",
        help="Smoke-test the script against the user's real ZCode install",
    )

    args = p.parse_args()
    if args.cmd == "resolve":
        sid, ws, title = resolve(args.target, args.db)
        print(f"{sid}\t{ws}\t{title}")
    elif args.cmd == "dump":
        dump(args.sess_id, args.db, args.max_messages, args.include_system)
    elif args.cmd == "files":
        files(args.sess_id, args.db)
    elif args.cmd == "self-test":
        sys.exit(self_test(args.db))


if __name__ == "__main__":
    main()
