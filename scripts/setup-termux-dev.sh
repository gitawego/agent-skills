#!/data/data/com.termux/files/usr/bin/bash
#
# setup-termux-dev.sh
# --------------------
# One-shot Termux dev-environment installer.
# Consolidates: opencode + bun + pi-coding-agent (+ extensions) +
# chromium + chrome-devtools MCP server (auto-launch).
#
# Idempotent: re-running only installs what's missing.
# Recent improvements:
#   - MCP smoke test (initialize + tools/list) after install.
#   - Stale-MCP-cache detection (warns when pi's cached hash != file hash).
#   - CDP launcher exposes :9222 for puppeteer/playwright.
#   - MCP server auto-launches Chromium on first tool call via
#     --executablePath + --chrome-arg (no --headless server flag).
#   - Install 'which' (Termux lacks it; the opencode installer invokes
#     `which opencode` inside check_version() and exits 1 without it).
#
# Tested on Termux (F-Droid) on Android aarch64.

set -euo pipefail

# ===========================================================================
# Paths & globals
# ===========================================================================
BASHRC="$HOME/.bashrc"
BINDIR="$HOME/.local/bin"
mkdir -p "$BINDIR"

# opencode
OPENCODE_DIR="$HOME/.opencode"
OPENCODE_BIN="$OPENCODE_DIR/bin/opencode"
OPENCODE_WRAPPER="$BINDIR/opencode"

# bun
BUN_PATH="$HOME/.bun/bin/bun"
BUN_WRAPPER="$BINDIR/bun"

# pi
PI_BIN="/data/data/com.termux/files/usr/bin/pi"
PI_AGENT_DIR="$HOME/.pi/agent"
PI_NPM_DIR="$PI_AGENT_DIR/npm"

# chromium
CHROME_REPO_PKG="x11-repo"
CHROME_PKG="chromium"
CHROME_BIN="/data/data/com.termux/files/usr/lib/chromium/chrome"
CDP_PORT="9222"
CDP_PROFILE_DIR="$HOME/.cdp-profile"
CDP_START_SCRIPT="$BINDIR/start-cdp"

# MCP server
MCP_DIR="$HOME/workspace/chrome-mcp"
MCP_PKG_DIR="$MCP_DIR/node_modules"
MCP_CONFIG="$HOME/.config/mcp/termux-chrome.json"

# pi extension list (matched to this machine's settings.json)
PI_EXTENSIONS=(
  "npm:pi-mcp-adapter"
  "npm:pi-subagents"
  "npm:pi-web-access"
  "npm:@quintinshaw/pi-dynamic-workflows"
  "npm:@narumitw/pi-goal"
  "git:github.com/obra/superpowers"
)

# ===========================================================================
# Sanity checks
# ===========================================================================
if [ -z "${PREFIX:-}" ] || [ "${PREFIX}" != "/data/data/com.termux/files/usr" ]; then
    echo "ERROR: this script must run inside Termux." >&2
    echo "       PREFIX=${PREFIX:-<unset>}" >&2
    exit 1
fi

have() { command -v "$1" >/dev/null 2>&1; }
step() { printf '\n==> %s\n' "$*"; }
ok()   { printf '    [ok] %s\n' "$*"; }
warn() { printf '    [warn] %s\n' "$*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

ensure_bashrc_line() {
    # ensure_bashrc_line <exact-line>  -> appends only if missing
    local line="$1"
    grep -Fqx "$line" "$BASHRC" 2>/dev/null || echo "$line" >> "$BASHRC"
}

ensure_path() {
    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BINDIR"; then
        ensure_bashrc_line ""
        ensure_bashrc_line "# setup-termux-dev"
        ensure_bashrc_line "export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
}

warn_if_mcp_cache_stale() {
    # warn_if_mcp_cache_stale <config-file>
    # pi caches the config hash it loaded; if that hash differs from the file
    # on disk, pi is running with stale config and MCP tools will fail with
    # "Cannot download a binary for the provided platform: android (arm64)".
    # Warns the user to restart pi.
    local config_path="$1"
    [ -f "$config_path" ] || return 0
    local cache="$HOME/.pi/agent/mcp-cache.json"
    [ -f "$cache" ] || return 0
    local config_hash cached_hash
    config_hash=$(sha256sum "$config_path" 2>/dev/null | awk '{print $1}')
    cached_hash=$(node -e "
        try {
            const c = require('$cache');
            console.log(c.servers?.['chrome-devtools']?.configHash || '');
        } catch { console.log(''); }
    " 2>/dev/null)
    if [ -n "$cached_hash" ] && [ "$cached_hash" != "$config_hash" ]; then
        warn "pi's MCP cache hash doesn't match $config_path on disk."
        warn "  file:    $config_hash"
        warn "  cached:  $cached_hash"
        warn "  Restart pi to apply the new config:  exit  (then re-run 'pi')"
    fi
}

# Check internet connectivity once, up front.
if ! curl -fsS --max-time 10 -o /dev/null https://github.com; then
    die "no internet access (github.com unreachable). Connect Wi-Fi/data and retry."
fi

# ===========================================================================
# Section 1: System prerequisites
# ===========================================================================
step "System prerequisites"

if ! have grun; then
    echo "    Installing glibc-runner (needed for opencode + bun)..."
    pkg update -y >/dev/null
    pkg install -y glibc-runner
else
    ok "glibc-runner present"
fi

if ! have node; then
    echo "    Installing nodejs..."
    pkg install -y nodejs-lts
else
    ok "node $(node --version)"
fi

if ! have npm; then
    pkg install -y npm
else
    ok "npm $(npm --version)"
fi

# Termux doesn't ship `which` by default, but the opencode installer
# (and many other third-party install scripts) call `which opencode` /
# `which $cmd` in their preflight checks. Without it those scripts
# fail with "which: command not found" and the install aborts.
if ! have which; then
    echo "    Installing which (needed by opencode installer preflight)..."
    pkg install -y which
else
    ok "which $(which which 2>/dev/null || echo present)"
fi

# ===========================================================================
# Section 2: opencode
# ===========================================================================
step "opencode"

if [ ! -x "$OPENCODE_BIN" ]; then
    echo "    Downloading opencode installer..."
    if ! curl -fsSL https://opencode.ai/install | bash; then
        warn "opencode installer failed; skipping (re-run later or visit https://opencode.ai/install)"
    fi
else
    ok "opencode already at $OPENCODE_BIN"
fi

if [ -x "$OPENCODE_BIN" ]; then
    if [ ! -e "$OPENCODE_WRAPPER" ]; then
        cat > "$OPENCODE_WRAPPER" <<'W'
#!/data/data/com.termux/files/usr/bin/bash
exec grun ~/.opencode/bin/opencode "$@"
W
        chmod +x "$OPENCODE_WRAPPER"
        ok "wrapper at $OPENCODE_WRAPPER"
    else
        ok "wrapper present at $OPENCODE_WRAPPER"
    fi

    if ! grep -q "alias opencode-upgrade" "$BASHRC" 2>/dev/null; then
        ensure_bashrc_line "alias opencode-upgrade='$OPENCODE_WRAPPER upgrade --method curl'"
        ok "opencode-upgrade alias added"
    else
        ok "opencode-upgrade alias present"
    fi

    if grun "$OPENCODE_BIN" --version >/dev/null 2>&1; then
        ok "version: $(grun "$OPENCODE_BIN" --version 2>/dev/null)"
    else
        warn "opencode --version failed (binary may still be functional)"
    fi

    # End-to-end check: the bare `opencode` command must resolve to the
    # grun wrapper, NOT to the raw glibc binary in ~/.opencode/bin.
    # The opencode installer prepends its own bin dir to PATH, which
    # shadows the wrapper and causes "cannot execute: required file not found".
    RESOLVED=$(command -v opencode 2>/dev/null || true)
    if [ "$RESOLVED" = "$OPENCODE_WRAPPER" ]; then
        ok "'opencode' resolves to wrapper ($RESOLVED)"
    elif [ -n "$RESOLVED" ]; then
        warn "'opencode' resolves to $RESOLVED, not the wrapper $OPENCODE_WRAPPER!"
        warn "  PATH shadowing: $OPENCODE_DIR/bin is ahead of $BINDIR in PATH."
        warn "  Fix: remove the line 'export PATH=.../.opencode/bin:\$PATH' from $BASHRC"
        warn "  (the wrapper in $BINDIR already handles glibc via grun)"
    fi
else
    warn "opencode not installed; wrapper/alias skipped"
fi

ensure_path

# ===========================================================================
# Section 3: Bun
# ===========================================================================
step "Bun"

if [ ! -x "$BUN_PATH" ]; then
    echo "    Downloading bun installer..."
    if ! curl -fsSL https://bun.sh/install | bash; then
        warn "bun installer failed; skipping"
    fi
else
    ok "bun already at $BUN_PATH"
fi

if [ -x "$BUN_PATH" ]; then
    if [ ! -e "$BUN_WRAPPER" ]; then
        cat > "$BUN_WRAPPER" <<W
#!/data/data/com.termux/files/usr/bin/bash
exec grun "$BUN_PATH" "\$@"
W
        chmod +x "$BUN_WRAPPER"
        ok "wrapper at $BUN_WRAPPER"
    else
        ok "wrapper present at $BUN_WRAPPER"
    fi

    if grun "$BUN_PATH" --version >/dev/null 2>&1; then
        ok "version: $(grun "$BUN_PATH" --version 2>/dev/null)"
    fi
fi

ensure_path

# ===========================================================================
# Section 4: pi-coding-agent + extensions
# ===========================================================================
step "pi-coding-agent"

if have pi; then
    ok "pi $(pi --version 2>/dev/null || echo unknown) at $(command -v pi)"
else
    echo "    Installing @earendil-works/pi-coding-agent..."
    if npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent; then
        ok "pi installed"
    else
        warn "pi install failed; section skipped"
    fi
fi

if have pi; then
    echo "    Installing pi extensions..."
    for ext in "${PI_EXTENSIONS[@]}"; do
        if pi list 2>/dev/null | grep -Fq "$ext"; then
            ok "extension already installed: $ext"
        else
            echo "      -> $ext"
            if pi install "$ext" >/dev/null 2>&1; then
                ok "installed $ext"
            else
                warn "failed to install $ext"
            fi
        fi
    done
fi

# ===========================================================================
# Section 5: Chromium
# ===========================================================================
step "Chromium (headless, for MCP / automation)"

# x11-repo is where Chromium lives — not in Termux's default repo.
if ! grep -rq "^[^#]*x11-repo" "$PREFIX/etc/apt/sources.list.d/" 2>/dev/null; then
    echo "    Enabling $CHROME_REPO_PKG..."
    pkg install -y "$CHROME_REPO_PKG"
else
    ok "$CHROME_REPO_PKG already enabled"
fi

if [ ! -x "$CHROME_BIN" ]; then
    echo "    Installing $CHROME_PKG..."
    pkg update -y >/dev/null
    pkg install -y "$CHROME_PKG"
else
    ok "$CHROME_PKG already installed"
fi

if [ ! -x "$CHROME_BIN" ]; then
    die "$CHROME_BIN missing after install. Try:  pkg reinstall $CHROME_PKG"
fi
ok "binary: $CHROME_BIN"
ok "version: $("$CHROME_BIN" --version 2>/dev/null | head -1)"

# Manual CDP launcher — useful for puppeteer/playwright that connect via WS.
# MCP clients should use the auto-launch config (Section 6) instead.
cat > "$CDP_START_SCRIPT" <<CDP_EOF
#!/data/data/com.termux/files/usr/bin/bash
# Launches headless Chromium with Chrome DevTools Protocol on $CDP_PORT.
# Point puppeteer/playwright at:  ws://127.0.0.1:$CDP_PORT/devtools/browser/<id>
set -euo pipefail
CHROME="$CHROME_BIN"
PORT="$CDP_PORT"
PROFILE="$CDP_PROFILE_DIR"
mkdir -p "\$PROFILE"
ps -ef | awk '/[c]hrome.*remote-debugging-port='\$PORT'/{print \$2}' \
    | xargs -r kill -9 2>/dev/null || true
sleep 1
"\$CHROME" \\
  --headless=new \\
  --no-sandbox \\
  --disable-gpu \\
  --disable-dev-shm-usage \\
  --hide-scrollbars \\
  --window-size=1280,800 \\
  --user-data-dir="\$PROFILE" \\
  --remote-debugging-port=\$PORT \\
  --remote-debugging-address=127.0.0.1 \\
  about:blank \\
  > "\$PROFILE/chrome.log" 2>&1 &
for i in \$(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:\$PORT/json/version" >/dev/null 2>&1; then
    echo "Chromium ready on http://127.0.0.1:\$PORT"
    exit 0
  fi
  sleep 1
done
echo "Chromium failed to start. Log:" >&2
tail -20 "\$PROFILE/chrome.log" >&2 || true
exit 1
CDP_EOF
chmod +x "$CDP_START_SCRIPT"
ok "CDP launcher: $CDP_START_SCRIPT"

# Smoke test: headless screenshot of example.com
SMOKE_SHOT="$HOME/.cache/setup-termux-dev-smoke.png"
mkdir -p "$(dirname "$SMOKE_SHOT")"
echo "    Smoke test: screenshot https://example.com ..."
if "$CHROME_BIN" \
    --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --hide-scrollbars --window-size=1280,800 \
    --screenshot="$SMOKE_SHOT" \
    https://example.com 2>/dev/null \
    && [ -s "$SMOKE_SHOT" ]; then
    ok "screenshot saved: $SMOKE_SHOT ($(wc -c <"$SMOKE_SHOT") bytes)"
else
    warn "screenshot smoke test failed; check logs"
fi

# ===========================================================================
# Section 6: chrome-devtools MCP server (auto-launch)
# ===========================================================================
step "chrome-devtools MCP server"

if have npm; then
    mkdir -p "$MCP_DIR"
    if [ ! -d "$MCP_PKG_DIR/chrome-devtools-mcp" ]; then
        echo "    Installing chrome-devtools-mcp into $MCP_DIR..."
        if ( cd "$MCP_DIR" && [ -f package.json ] || npm init -y >/dev/null ) \
            && ( cd "$MCP_DIR" && npm install --no-audit --no-fund chrome-devtools-mcp >/dev/null 2>&1 ); then
            ok "chrome-devtools-mcp installed"
        else
            warn "chrome-devtools-mcp install failed; section skipped"
        fi
    else
        ok "chrome-devtools-mcp already installed"
    fi
else
    warn "npm not available; MCP install skipped"
fi

# Always (re)write the auto-launch MCP config — it's cheap and keeps it in sync.
if [ -d "$MCP_PKG_DIR/chrome-devtools-mcp" ]; then
    mkdir -p "$(dirname "$MCP_CONFIG")"
    cat > "$MCP_CONFIG" <<MCPJSON
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "node",
      "args": [
        "$MCP_PKG_DIR/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
        "--executablePath=$CHROME_BIN",
        "--chrome-arg=--headless=new",
        "--chrome-arg=--no-sandbox",
        "--chrome-arg=--disable-gpu",
        "--chrome-arg=--disable-dev-shm-usage",
        "--chrome-arg=--hide-scrollbars",
        "--chrome-arg=--window-size=1280,800"
      ]
    }
  }
}
MCPJSON
    ok "MCP config (auto-launches Chromium on first tool call): $MCP_CONFIG"

    # End-to-end smoke test: drive the server via raw JSON-RPC and verify
    # that 'initialize' succeeds and 'tools/list' returns the expected tools.
    # Catches the most common failure: missing --executablePath (which makes
    # the server fall back to "download Chrome for android-arm64" and die).
    echo "    MCP smoke test (initialize + tools/list)..."
    MCP_SMOKE_OUT=$(cd "$MCP_DIR" && node -e '
        const { spawn } = require("child_process");
        const path = require("path");
        const server = path.join("'"$MCP_PKG_DIR"'", "chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js");
        const c = spawn("node", [
            server,
            "--executablePath='"$CHROME_BIN"'",
            "--chrome-arg=--headless=new",
            "--chrome-arg=--no-sandbox",
            "--chrome-arg=--disable-gpu",
            "--chrome-arg=--disable-dev-shm-usage",
        ], { stdio: ["pipe","pipe","pipe"] });
        let buf = ""; const pending = new Map(); let id = 1;
        c.stdout.on("data", chunk => {
            buf += chunk.toString();
            let nl;
            while ((nl = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, nl).trim(); buf = buf.slice(nl+1);
                if (!line) continue;
                try {
                    const m = JSON.parse(line);
                    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
                } catch {}
            }
        });
        c.stderr.on("data", () => {});
        const call = (method, params={}) => new Promise((res, rej) => {
            const myId = id++;
            c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:myId,method,params})+"\n");
            pending.set(myId, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result));
            setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error("timeout")); } }, 30000);
        });
        (async () => {
            try {
                const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
                c.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
                const tl = await call("tools/list", {});
                const n = tl.tools.length;
                if (n < 25) throw new Error("only " + n + " tools (expected >=25)");
                console.log("OK v" + init.serverInfo.version + " " + n + " tools");
            } catch (e) { console.log("FAIL " + e.message); process.exitCode = 1; }
            c.kill();
            setTimeout(() => process.exit(process.exitCode || 0), 500);
        })();
    ' 2>/dev/null)
    if echo "$MCP_SMOKE_OUT" | grep -q "^OK "; then
        ok "MCP server responsive: ${MCP_SMOKE_OUT#OK }"
    else
        warn "MCP smoke test failed: ${MCP_SMOKE_OUT#FAIL }"
    fi

    warn_if_mcp_cache_stale "$MCP_CONFIG"
else
    warn "MCP config not written (chrome-devtools-mcp not installed)"
fi

# ===========================================================================
# Summary
# ===========================================================================
step "Done."

OPENCODE_VER=$(grun "$OPENCODE_BIN" --version 2>/dev/null || echo "not installed")
BUN_VER=$(grun "$BUN_PATH" --version 2>/dev/null || echo "not installed")
PI_VER=$(pi --version 2>/dev/null || echo "not installed")
CHROME_VER=$("$CHROME_BIN" --version 2>/dev/null | head -1 || echo "not installed")

cat <<SUMMARY

    opencode
      wrapper:    $OPENCODE_WRAPPER
      version:    $OPENCODE_VER
      upgrade:    opencode-upgrade

    bun
      wrapper:    $BUN_WRAPPER
      version:    $BUN_VER

    pi-coding-agent
      binary:     $PI_BIN
      version:    $PI_VER
      extensions: ${#PI_EXTENSIONS[@]} configured
                  ${PI_EXTENSIONS[*]}

    Chromium (headless, MCP-ready)
      binary:     $CHROME_BIN
      version:    $CHROME_VER
      manual CDP: $CDP_START_SCRIPT          # exposes :$CDP_PORT (puppeteer/playwright)
      stop CDP:   pkill -f 'remote-debugging-port=$CDP_PORT'
      smoke shot: $SMOKE_SHOT

    MCP server (auto-launches Chromium — no manual start needed)
      package:    $MCP_PKG_DIR/chrome-devtools-mcp
      config:     $MCP_CONFIG
      smoke test: ${MCP_SMOKE_OUT:-skipped}

    Next steps
      Restart Termux or run:    source $BASHRC
      Wire MCP into your client (pi / Claude Desktop / etc.):
          point it at $MCP_CONFIG
          (or merge its contents into your client's mcpServers block)
          If the script warned about a stale MCP cache, restart pi:
              exit  (then re-run 'pi')
      Raw CDP for puppeteer/playwright:
          start:   $CDP_START_SCRIPT
          ws:      ws://127.0.0.1:$CDP_PORT/devtools/browser/<id>

SUMMARY