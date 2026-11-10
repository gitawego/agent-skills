#!/usr/bin/env python3
"""Install (or remove) the Lutris pre-launch hook that keeps NetEase Cloud
Music covers rendering under Wine.

The client serves covers through its own orpheus://cache/?<url> handler backed
by an on-disk cache. Under Wine, state written by one session is not reliably
readable by the next, so later launches paint grey placeholders. Clearing that
state before every launch removes the failure condition; this script wires a
cleanup command into the game's Lutris config so it happens automatically.

It copies the cleanup script to a stable location (~/.local/bin) so the hook
does not depend on the skill folder staying put, edits only the game YAML
(never the Wine prefix), and always keeps a timestamped backup.

Usage:
  install-lutris-hook.py [--game PATH] [--bin-dir DIR] [--dry-run]
  install-lutris-hook.py --remove [--game PATH]
"""

import argparse
import datetime as dt
import shutil
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_CLEAR = HERE / "clear-client-state.sh"
HOOK_NAME = "netease-clear-cache"

GAME_DIRS = [
    Path.home() / ".local/share/lutris/games",
    Path.home() / ".config/lutris/games",
    Path.home() / ".var/app/net.lutris.Lutris/data/lutris/games",
]

MATCH_HINTS = ("cloudmusic.exe", "netease", "\u7f51\u6613\u4e91")


def score_config(text, path):
    """Rank configs so the installed game wins over its installer recipe."""
    low = text.lower()
    score = 0
    if re.search(r"^\s+exe:.*cloudmusic\.exe", text, re.M | re.I):
        score += 4
    if "cloudmusic.exe" in low:
        score += 2
    if re.search(r"^script:", text, re.M):
        score -= 2
    if "setup" in path.name.lower():
        score -= 4
    if "netease cloud music" in low:
        score += 1
    return score


def candidate_configs():
    found = []
    for d in GAME_DIRS:
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.yml")):
            try:
                text = f.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            low = text.lower()
            if any(h in low for h in MATCH_HINTS):
                found.append((f, text, score_config(text, f)))
    return found


def block_bounds(lines, key):
    """Return (start, end) for a top-level '<key>:' mapping block."""
    start = None
    for i, line in enumerate(lines):
        if re.match(r"^" + re.escape(key) + r":\s*$", line):
            start = i
            break
        if re.match(r"^" + re.escape(key) + r":\s*\S", line):
            raise SystemExit(
                f"refusing to edit: '{key}:' uses inline mapping syntax; add the keys by hand"
            )
    if start is None:
        return None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        stripped = lines[j].strip()
        if stripped and not lines[j][0].isspace() and not stripped.startswith("#"):
            end = j
            break
    return start, end


def find_key(lines, bounds, key):
    start, end = bounds
    pattern = re.compile(r"^(\s+)" + re.escape(key) + r":\s*(.*)$")
    for i in range(start + 1, end):
        m = pattern.match(lines[i])
        if m:
            return i, m.group(1), m.group(2).strip()
    return None, "  ", None


def apply_hook(lines, command, force):
    bounds = block_bounds(lines, "system")
    if bounds is None:
        if lines and lines[-1].strip():
            lines.append("\n")
        lines.append("system:\n")
        bounds = (len(lines) - 1, len(lines))

    idx, indent, value = find_key(lines, bounds, "prelaunch_command")
    if idx is not None:
        if value.strip("'\"") == command:
            print("prelaunch_command already points at this script; nothing to do")
            return False
        if not force:
            raise SystemExit(
                f"refusing to overwrite an existing prelaunch_command:\n  {value}\n"
                "Re-run with --force to replace it, or chain it manually."
            )
        lines[idx] = f"{indent}prelaunch_command: {command}\n"

    wait_idx, wait_indent, _ = find_key(lines, bounds, "prelaunch_wait")
    if wait_idx is not None:
        lines[wait_idx] = f"{wait_indent}prelaunch_wait: true\n"

    insert_at = bounds[1]
    if idx is None:
        lines.insert(insert_at, f"  prelaunch_command: {command}\n")
        insert_at += 1
    if wait_idx is None:
        lines.insert(insert_at, "  prelaunch_wait: true\n")
    return True


def remove_hook(lines):
    changed = False
    for key in ("prelaunch_command", "prelaunch_wait"):
        bounds = block_bounds(lines, "system")
        if not bounds:
            continue
        idx, _, _ = find_key(lines, bounds, key)
        if idx is not None:
            del lines[idx]
            changed = True
    return changed


def free_backup_path(target):
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = target.with_suffix(target.suffix + f".bak-{stamp}")
    n = 1
    while candidate.exists():
        candidate = target.with_suffix(target.suffix + f".bak-{stamp}-{n}")
        n += 1
    return candidate


def install_clear_script(source, bin_dir, dry_run):
    dest = Path(bin_dir).expanduser() / HOOK_NAME
    if dry_run:
        print(f"--- would install cleanup script to {dest} ---")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)
    dest.chmod(0o755)
    print(f"installed cleanup script: {dest}")
    return dest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clear-script", default=str(DEFAULT_CLEAR))
    ap.add_argument("--bin-dir", default=str(Path.home() / ".local/bin"))
    ap.add_argument("--game", help="explicit path to the Lutris game .yml")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--remove", action="store_true", help="uninstall the hook")
    ap.add_argument("--force", action="store_true", help="overwrite an existing prelaunch_command")
    args = ap.parse_args()

    if args.game:
        target = Path(args.game).expanduser()
        if not target.is_file():
            raise SystemExit(f"no such game config: {target}")
    else:
        found = candidate_configs()
        if not found:
            raise SystemExit(
                "could not find a Lutris game config for NetEase Cloud Music.\n"
                "Looked in: " + ", ".join(str(d) for d in GAME_DIRS) + "\n"
                "Pass --game <path-to-yml> if your config lives elsewhere."
            )
        best = max(s for _, _, s in found)
        winners = [f for f, _, s in found if s == best]
        if len(winners) > 1:
            print("ambiguous: several game configs match; pass --game <path>:")
            for f, _, s in found:
                print(f"  - {f}  (score {s})")
            raise SystemExit(2)
        target = winners[0]
        if len(found) > 1:
            print(f"selected {target} (score {best})")

    lines = target.read_text(encoding="utf-8").splitlines(keepends=True)

    if args.remove:
        changed = remove_hook(lines)
    else:
        source = Path(args.clear_script).expanduser().resolve()
        if not source.is_file():
            raise SystemExit(f"clear script not found: {source}")
        command_path = install_clear_script(source, args.bin_dir, args.dry_run)
        changed = apply_hook(lines, str(command_path), args.force)

    if not changed:
        return 0

    if args.dry_run:
        print(f"--- would write {target} ---")
        print("".join(lines))
        return 0

    backup = free_backup_path(target)
    shutil.copy2(target, backup)
    target.write_text("".join(lines), encoding="utf-8")
    print(f"{'removed' if args.remove else 'installed'} prelaunch hook in {target}")
    print(f"backup: {backup}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
