#!/data/data/com.termux/files/usr/bin/bash
# cdp-lifecycle.sh — tie the CDP (headless Chrome) lifecycle to the
# chrome-devtools-mcp server lifecycle, so nothing lingers when idle.
#
#   bash cdp-lifecycle.sh <mcp-server-js> [server args...]
#
# 1. ensures CDP is up (start-cdp.sh, idempotent)
# 2. runs the MCP server in the background and waits on it
# 3. on signal (idle shutdown / crash / SIGTERM), kills the MCP server AND
#    tears down CDP so the headless shell does not keep consuming RAM.
set -u

START_CDP="${CDP_START_SCRIPT:-$HOME/workspace/agent-skills/skills/chrome-devtools-mcp-pi/scripts/start-cdp.sh}"
PORT="${CDP_PORT:-9222}"
MCP_SERVER="${1:?usage: cdp-lifecycle.sh <mcp-server-js> [args...]}"
shift

cdp_up() {
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1
}

kill_cdp() {
  # Root shell carries the port; children (zygote/gpu/renderer) may not, so
  # fall back to killing by the headless_shell image name too.
  pids=$(ps -ef | awk '/[h]eadless[-_]?shell.*remote-debugging-port='$PORT'/{print $2}')
  [ -n "$pids" ] && echo "$pids" | xargs -r kill -9 2>/dev/null
  sleep 0.5
  pkill -9 -f "headless_shell.*$PORT" 2>/dev/null
  pkill -9 -f "[h]eadless_shell" 2>/dev/null
  pkill -9 -f "[c]hrome-devtools-mcp" 2>/dev/null
  sleep 0.3
}

SERVER_PID=""
cleanup() {
  # Kill the MCP server first, then tear down CDP. Runs immediately on signal
  # (bash does NOT defer this trap: the server runs as a background child and
  # we wait on it, so the trap fires while `wait` is active).
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null
    sleep 0.5
    kill -9 "$SERVER_PID" 2>/dev/null
  fi
  kill_cdp
}
trap cleanup EXIT INT TERM HUP

# 1. Ensure CDP is up (idempotent: no-op if already responsive).
if ! cdp_up; then
  bash "$START_CDP" >/dev/null 2>&1 || echo "cdp-lifecycle: warning: start-cdp.sh failed; server may not have a browser" >&2
fi

# 2. Run the MCP server as a background child so the signal trap fires
#    immediately (a foreground child would defer the trap until it exits).
#    IMPORTANT: explicitly pass stdin through (<&0) — without job control,
#    bash gives background jobs /dev/null as stdin, which the stdio MCP
#    server reads as instant EOF and shuts down immediately.
node "$MCP_SERVER" "$@" <&0 &
SERVER_PID=$!
wait "$SERVER_PID"
status=$?

# 3. trap cleanup runs on EXIT.
exit $status
