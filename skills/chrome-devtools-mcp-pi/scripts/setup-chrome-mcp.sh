#!/usr/bin/env bash
# setup-chrome-mcp.sh — idempotent setup of Chrome DevTools MCP (skill copy).
#
# Self-contained: resolves all paths from this skill's own location and $HOME.
# Installs/verifies in order:
#   1. Playwright headless-shell (arm64) → ~/.cache/ms-playwright/headless-shell-<rev>/
#   2. chrome-devtools-mcp npm package    → ${CHROME_MCP_DIR:-~/workspace/chrome-mcp}/
#   3. pi MCP config                     → ~/.pi/agent/mcp.json
#      (env.CDP_READY = "!bash <skill>/scripts/start-cdp.sh --ensure" — the
#       pi-mcp-adapter runs it at server-connect time, so every MCP browser
#       tool call automatically has CDP up. No manual browser start needed.)
#   4. Verifies CDP is up on 127.0.0.1:9222
#
# Idempotent: re-running is safe; already-good steps are skipped and reported.
# --force reinstalls browser + npm and rewrites the config; --status only checks.
#
# Env overrides: CDP_HEADLESS_SHELL, CDP_PORT, CDP_USER_DATA_DIR, CHROME_MCP_DIR
# Exit: 0 = all good; 1 = something could not be ensured.
set -uo pipefail

# --- skill-relative paths ----------------------------------------------------
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_CDP="$SKILL_DIR/scripts/start-cdp.sh"

# --- user paths (overridable) ------------------------------------------------
CHROME_MCP_DIR="${CHROME_MCP_DIR:-$HOME/workspace/chrome-mcp}"
MCP_CONFIG="${MCP_CONFIG:-$HOME/.pi/agent/mcp.json}"
PLAYWRIGHT_CACHE="${PLAYWRIGHT_CACHE:-$HOME/.cache/ms-playwright}"

# Playwright 1.62.x pins chromium headless-shell revision 1234 (Chromium 151).
HS_REV="${HS_REV:-1234}"
HS_URL="https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/$HS_REV/chromium-headless-shell-linux-arm64.zip"
HS_DIR="$PLAYWRIGHT_CACHE/headless-shell-$HS_REV"
HS_BIN="${CDP_HEADLESS_SHELL:-$HS_DIR/headless_shell}"

CHROME_DEVTOOLS_PKG="chrome-devtools-mcp@1.6.0"
MCP_SERVER="$CHROME_MCP_DIR/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"

MODE="ensure"
[[ "${1:-}" == "--force" ]] && MODE="force"
[[ "${1:-}" == "--status" ]] && MODE="status"

say()  { printf '%s\n' "$*"; }
fail() { say "ERROR: $*" >&2; exit 1; }
ok()   { say "  ✓ $*"; }
skip() { say "  - $* (already in place)"; }

if [[ "$MODE" == "status" ]]; then
  say "== Chrome DevTools MCP (pi) status =="
  [[ -x "$HS_BIN" ]] && ok "headless-shell: $($HS_BIN --version 2>/dev/null)" || skip "headless-shell missing"
  [[ -f "$MCP_SERVER" ]] && ok "chrome-devtools-mcp installed" || skip "chrome-devtools-mcp missing"
  [[ -x "$START_CDP" ]] && ok "start-cdp.sh present" || skip "start-cdp.sh missing"
  if [[ -f "$MCP_CONFIG" ]] && grep -q 'CDP_READY' "$MCP_CONFIG" 2>/dev/null; then
    ok "pi MCP config declares chrome-devtools + CDP_READY auto-start"
  else
    skip "pi MCP config missing chrome-devtools/CDP_READY"
  fi
  if curl -fsS --max-time 2 "http://127.0.0.1:${CDP_PORT:-9222}/json/version" >/dev/null 2>&1; then
    ok "CDP up on 127.0.0.1:${CDP_PORT:-9222}"
  else
    skip "CDP down (run scripts/start-cdp.sh)"
  fi
  exit 0
fi

say "== Chrome DevTools MCP (pi) setup =="

# --- 1. headless-shell -------------------------------------------------------
if [[ -x "$HS_BIN" ]]; then
  skip "headless-shell ($($HS_BIN --version 2>/dev/null))"
elif [[ "$MODE" == "force" ]]; then
  say "Reinstalling headless-shell (rev $HS_REV, arm64)..."
  rm -rf "$HS_DIR" "$HS_DIR.zip"
  mkdir -p "$PLAYWRIGHT_CACHE"
  for i in 1 2 3 4 5 6; do
    curl -fL -C - --retry 5 --retry-delay 3 -o "$HS_DIR.zip" "$HS_URL" 2>/dev/null || true
    SZ=$(stat -c%s "$HS_DIR.zip" 2>/dev/null || echo 0)
    [[ "$SZ" -ge 100000000 ]] && break
    sleep 2
  done
  if ! unzip -q -o "$HS_DIR.zip" -d "$HS_DIR" 2>/dev/null; then
    fail "failed to download/extract headless-shell from $HS_URL"
  fi
  chmod +x "$HS_DIR/headless_shell"
  ok "headless-shell: $($HS_BIN --version 2>/dev/null)"
else
  say "Downloading headless-shell (rev $HS_REV, arm64) — first run, may take a few minutes..."
  mkdir -p "$PLAYWRIGHT_CACHE"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -fL -C - --retry 5 --retry-delay 3 -o "$HS_DIR.zip" "$HS_URL" 2>/dev/null || true
    SZ=$(stat -c%s "$HS_DIR.zip" 2>/dev/null || echo 0)
    [[ "$SZ" -ge 100000000 ]] && break
    sleep 2
  done
  if ! unzip -q -o "$HS_DIR.zip" -d "$HS_DIR" 2>/dev/null; then
    fail "failed to download/extract headless-shell from $HS_URL"
  fi
  chmod +x "$HS_DIR/headless_shell"
  ok "headless-shell: $($HS_BIN --version 2>/dev/null)"
fi

# --- 2. chrome-devtools-mcp npm ----------------------------------------------
if [[ -f "$MCP_SERVER" ]]; then
  skip "chrome-devtools-mcp ($(node -e "console.log(require('$CHROME_MCP_DIR/node_modules/chrome-devtools-mcp/package.json').version)" 2>/dev/null))"
else
  say "Installing $CHROME_DEVTOOLS_PKG in $CHROME_MCP_DIR..."
  mkdir -p "$CHROME_MCP_DIR"
  (cd "$CHROME_MCP_DIR" && npm install --no-audit --no-fund "$CHROME_DEVTOOLS_PKG") || fail "npm install failed"
  ok "chrome-devtools-mcp installed"
fi

# --- 3. start-cdp.sh ----------------------------------------------------------
[[ -x "$START_CDP" ]] || fail "start-cdp.sh missing at $START_CDP — it lives in this skill"

# --- 4. pi MCP config ---------------------------------------------------------
mkdir -p "$(dirname "$MCP_CONFIG")"
if [[ -f "$MCP_CONFIG" ]] && grep -q 'CDP_READY' "$MCP_CONFIG" 2>/dev/null && [[ "$MODE" != "force" ]]; then
  skip "pi MCP config already declares chrome-devtools + CDP_READY auto-start"
else
  cat > "$MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "node",
      "args": [
        "$MCP_SERVER",
        "--browserUrl=http://127.0.0.1:9222",
        "--headless=true",
        "--no-usage-statistics",
        "--no-performance-crux"
      ],
      "env": {
        "CDP_READY": "!bash $START_CDP --ensure"
      }
    }
  }
}
EOF
  ok "wrote $MCP_CONFIG (auto-starts CDP on server connect)"
  say "NOTE: run /reload in pi to re-read the MCP config"
fi

# --- 5. ensure CDP up ---------------------------------------------------------
say "Ensuring CDP is up on 127.0.0.1:9222..."
if [[ "$MODE" == "force" ]]; then bash "$START_CDP" --force; else bash "$START_CDP"; fi

say ""
say "Done. chrome-devtools MCP is ready."
say "  - Browser:  $HS_BIN"
say "  - CDP:      http://127.0.0.1:${CDP_PORT:-9222}"
say "  - Launcher: $START_CDP"
say "  - Config:   $MCP_CONFIG"
