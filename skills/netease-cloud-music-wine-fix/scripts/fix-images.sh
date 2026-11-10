#!/usr/bin/env bash
# Quit NetEase Cloud Music, clear its cache/state, and relaunch it.
# This is the manual form of the permanent fix; prefer installing the Lutris
# pre-launch hook (scripts/install-lutris-hook.py) so it happens by itself.
#
# Login is preserved. Expect a possible one-time "网易云音乐崩溃了" dialog on
# the first start afterwards; dismissing it and starting again is normal.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) shift; DATA_DIR="${1:-}" ;;
    -h|--help) sed -n '1,12p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# Resolve the wine prefix from the data dir if one was given explicitly.
PREFIX=""
if [ -n "$DATA_DIR" ]; then
  PREFIX="${DATA_DIR%%/drive_c/*}"
fi

echo "==> closing the client"
pkill -x cloudmusic.exe 2>/dev/null
sleep 2
if [ -n "$PREFIX" ]; then
  WINEPREFIX="$PREFIX" wineserver -k 2>/dev/null
else
  wineserver -k 2>/dev/null
fi
sleep 3

if [ -n "$DATA_DIR" ]; then
  "$HERE/clear-client-state.sh" --data-dir "$DATA_DIR"
else
  "$HERE/clear-client-state.sh"
fi

echo
if command -v lutris >/dev/null 2>&1; then
  GAME_ID="${NETEASE_LUTRIS_ID:-}"
  if [ -z "$GAME_ID" ] && command -v sqlite3 >/dev/null 2>&1; then
    DB="$HOME/.local/share/lutris/pga.db"
    [ -f "$DB" ] || DB="$HOME/.config/lutris/pga.db"
    [ -f "$DB" ] && GAME_ID="$(sqlite3 "$DB" "select id from games where lower(name) like '%netease%' or name like '%云音乐%' order by id limit 1;" 2>/dev/null)"
  fi
  if [ -n "$GAME_ID" ]; then
    echo "==> relaunching (lutris game id $GAME_ID)"
    setsid lutris "lutris:rungameid/$GAME_ID" >/dev/null 2>&1 &
    exit 0
  fi
fi
echo "==> start the client from Lutris (could not determine the Lutris game id;"
echo "    set NETEASE_LUTRIS_ID=<id> to have this script relaunch it)."
exit 0
