#!/usr/bin/env bash
# start-cdp.sh — idempotent CDP launcher (self-contained skill copy).
#
# Ensures a headless Chromium with CDP is listening on 127.0.0.1:9222 for
# chrome-devtools-mcp (which connects via --browserUrl). Idempotent: if CDP is
# already up, does nothing and exits 0. Detached with setsid+disown so it
# survives the launching shell.
#
# Usage:
#   start-cdp.sh            # ensure CDP, wait up to 60s
#   start-cdp.sh --force    # restart even if up
#   start-cdp.sh --status   # check only
# Exit: 0 = CDP up, 1 = failed / down.
set -uo pipefail

HS="${CDP_HEADLESS_SHELL:-}"
PORT="${CDP_PORT:-9222}"
ADDR="127.0.0.1"
DIR="${CDP_USER_DATA_DIR:-$HOME/.cdp-headless}"
URL="http://$ADDR:$PORT/json/version"
WAIT_SECS=60

# If CDP_HEADLESS_SHELL isn't set, probe the two standard Playwright cache
# locations so the script works whether the binary came from this skill's
# setup or from a manual/playwright-cli install.
if [[ -z "$HS" ]]; then
  for cand in \
    "$HOME/.cache/ms-playwright/headless-shell-1234/headless_shell" \
    "$HOME/.cache/ms-playwright/headless-shell-1234/chrome-linux/headless_shell"; do
    if [[ -x "$cand" ]]; then HS="$cand"; break; fi
  done
fi

MODE="ensure"
[[ "${1:-}" == "--force" ]] && MODE="force"
[[ "${1:-}" == "--status" ]] && MODE="status"

say()  { printf '%s\n' "$*"; }
fail() { say "ERROR: $*" >&2; exit 1; }

cdp_up()     { curl -fsS --max-time 2 "$URL" >/dev/null 2>&1; }
cdp_version(){ curl -fsS --max-time 2 "$URL" 2>/dev/null | grep -o '"Browser": *"[^"]*"' | head -1 || echo "unknown"; }

if [[ "$MODE" == "status" ]]; then
  if cdp_up; then say "CDP is up on $URL ($(cdp_version))"; exit 0; fi
  say "CDP is DOWN on $URL"
  exit 1
fi

if [[ "$MODE" == "ensure" ]] && cdp_up; then
  say "CDP already up on $URL ($(cdp_version)) — nothing to do"
  exit 0
fi

[[ -x "$HS" ]] || fail "headless-shell not found — run scripts/setup-chrome-mcp.sh first (or set CDP_HEADLESS_SHELL)"

mkdir -p "$DIR"
pkill -9 -f "headless_shell.*remote-debugging-port=$PORT" 2>/dev/null
sleep 1

setsid "$HS" \
  --headless=new \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --hide-scrollbars \
  --window-size=1280,800 \
  --user-data-dir="$DIR" \
  --remote-debugging-port=$PORT \
  --remote-debugging-address=$ADDR \
  about:blank > "$DIR/shell.log" 2>&1 < /dev/null &
disown

for ((i = 1; i <= WAIT_SECS; i++)); do
  if cdp_up; then
    say "headless-shell ready on $URL ($(cdp_version))"
    exit 0
  fi
  sleep 1
done

say "headless-shell failed to start within ${WAIT_SECS}s" >&2
tail -20 "$DIR/shell.log" >&2
exit 1
