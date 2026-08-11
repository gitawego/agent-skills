#!/data/data/com.termux/files/usr/bin/bash
# start-cdp.sh — idempotent CDP launcher for chrome-devtools-mcp (Termux-native edition).
#
# Termux native runs bionic libc; Playwright's prebuilt arm64 headless-shell is a
# glibc binary, so it is launched through glibc-runner (see headless-shell-runner.sh).
#
#   start-cdp.sh            ensure CDP is up (no-op if already responsive)
#   start-cdp.sh --force    kill any instance on $CDP_PORT, restart fresh
#   start-cdp.sh --status   print status checklist, change nothing
#
# Env overrides: CDP_HEADLESS_SHELL, CDP_PORT, CDP_USER_DATA_DIR
set -u

RUNNER="${CDP_RUNNER:-$HOME/.cache/ms-playwright/headless-shell-1234/headless-shell-runner.sh}"
PORT="${CDP_PORT:-9222}"
DIR="${CDP_USER_DATA_DIR:-$HOME/.cdp-headless}"
mkdir -p "$DIR"

status_check() {
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1
}

if [[ "${1:-}" == "--status" ]]; then
  echo "== CDP status (port $PORT) =="
  [[ -x "$RUNNER" ]] && echo "  ok   runner: $RUNNER" || echo "  MISS runner: $RUNNER"
  if status_check; then
    echo "  ok   CDP up:  http://127.0.0.1:$PORT"
    curl -s "http://127.0.0.1:$PORT/json/version" | head -c 200; echo
  else
    echo "  down CDP not responding (run: bash $0)"
  fi
  exit 0
fi

if [[ "${1:-}" == "--force" ]]; then
  # Kill whatever owns the port
  pids=$(ps -ef | awk '/[h]eadless[-_]?shell.*remote-debugging-port='$PORT'/{print $2}')
  [[ -n "$pids" ]] && echo "$pids" | xargs -r kill -9 2>/dev/null
  sleep 1
elif status_check; then
  echo "CDP already up on 127.0.0.1:$PORT — nothing to do"
  exit 0
fi

# Start detached
setsid "$RUNNER" \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --hide-scrollbars \
  --window-size=1280,800 \
  --user-data-dir="$DIR" \
  --remote-debugging-port=$PORT \
  --remote-debugging-address=127.0.0.1 \
  about:blank > "$DIR/shell.log" 2>&1 < /dev/null &

# Wait until CDP responds
for i in $(seq 1 60); do
  if status_check; then
    echo "headless-shell ready on http://127.0.0.1:$PORT"
    curl -s "http://127.0.0.1:$PORT/json/version" | head -c 300
    echo
    exit 0
  fi
  sleep 1
done
echo "headless-shell failed to start within 60s — log tail:"
tail -20 "$DIR/shell.log"
exit 1
