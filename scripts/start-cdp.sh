#!/usr/bin/env bash
# start-cdp.sh — idempotent launcher for the Chrome DevTools headless-shell.
#
# Ensures a headless Chromium with CDP (Chrome DevTools Protocol) is listening
# on 127.0.0.1:9222, which chrome-devtools-mcp connects to via --browserUrl.
#
# Idempotency contract:
#   * If CDP is ALREADY up on $PORT → prints status and exits 0 (no restart).
#   * If a stale/incompatible headless-shell is bound to $PORT → kills it and
#     starts a fresh one.
#   * Re-running is always safe; never double-starts the browser.
#
# Usage:
#   start-cdp.sh            # ensure CDP, wait up to 60s, exit 0/1
#   start-cdp.sh --force    # restart even if CDP is up
#   start-cdp.sh --status   # check only, never start
#
# Exit codes:
#   0  CDP is up (after ensuring or because it already was)
#   1  CDP did not come up within the timeout / binary missing
set -uo pipefail

# --- config -----------------------------------------------------------------
HS="${CDP_HEADLESS_SHELL:-/home/hlu/.cache/ms-playwright/headless-shell-1234/headless_shell}"
PORT="${CDP_PORT:-9222}"
ADDR="127.0.0.1"
DIR="${CDP_USER_DATA_DIR:-$HOME/.cdp-headless}"
URL="http://$ADDR:$PORT/json/version"
WAIT_SECS=60

MODE="ensure"
if [[ "${1:-}" == "--force" ]]; then MODE="force"; fi
if [[ "${1:-}" == "--status" ]]; then MODE="status"; fi

# --- helpers ----------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
fail() { say "ERROR: $*" >&2; exit 1; }

cdp_up() {
  curl -fsS --max-time 2 "$URL" >/dev/null 2>&1
}

cdp_version() {
  curl -fsS --max-time 2 "$URL" 2>/dev/null | grep -o '"Browser": *"[^"]*"' | head -1 || echo "unknown"
}

# --- status-only mode -------------------------------------------------------
if [[ "$MODE" == "status" ]]; then
  if cdp_up; then
    say "CDP is up on http://$ADDR:$PORT ($(cdp_version))"
    exit 0
  fi
  say "CDP is DOWN on http://$ADDR:$PORT (headless-shell not running)"
  exit 1
fi

# --- ensure / force ---------------------------------------------------------
if [[ "$MODE" == "ensure" ]] && cdp_up; then
  say "CDP already up on http://$ADDR:$PORT ($(cdp_version)) — nothing to do"
  exit 0
fi

# Binary present?
if [[ ! -x "$HS" ]]; then
  fail "headless-shell not found at $HS — run setup-chrome-mcp.sh first (or set CDP_HEADLESS_SHELL)"
fi

mkdir -p "$DIR"

# If something is squatting on the port (stale/incompatible), clear it.
if curl -fsS --max-time 1 "$URL" >/dev/null 2>&1; then
  say "Replacing stale CDP instance on port $PORT"
fi
pkill -9 -f "headless_shell.*remote-debugging-port=$PORT" 2>/dev/null
sleep 1

# Launch detached (setsid + disown so it survives the launching shell exiting).
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

# Wait until CDP is responsive.
for ((i = 1; i <= WAIT_SECS; i++)); do
  if cdp_up; then
    say "headless-shell ready on http://$ADDR:$PORT ($(cdp_version))"
    exit 0
  fi
  sleep 1
done

say "headless-shell failed to start within ${WAIT_SECS}s" >&2
tail -20 "$DIR/shell.log" >&2
exit 1
