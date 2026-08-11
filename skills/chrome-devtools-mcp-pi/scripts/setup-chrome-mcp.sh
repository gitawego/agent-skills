#!/usr/bin/env bash
# =============================================================================
# setup-chrome-mcp.sh — self-contained installer for Chrome DevTools MCP on
#                       Termux / proot (arm64), wired into pi-mcp-adapter.
#
# SCOPE
#   * Installs Playwright's headless-shell (the lightweight arm64 Chromium) as
#     a persistent CDP endpoint on 127.0.0.1:9222.
#   * Makes Playwright's browser work on Termux — the crux: Playwright's
#     prebuilt arm64 binaries are GLIBC-linked, while Termux native runs BIONIC
#     libc. This script bridges the gap (patchelf + glibc rootfs + runner
#     wrapper) or skips it entirely inside proot-distro (native glibc).
#   * Installs chrome-devtools-mcp npm, then writes ~/.pi/agent/mcp.json with a
#     lazy lifecycle (spawn on first tool use, idle-shutdown) and a
#     cdp-lifecycle.sh wrapper that auto-starts the browser at server-connect
#     time and tears Chrome down when the server exits. No agent has to
#     remember to start Chrome — or stop it — manually.
#
# IDEMPOTENT: re-running is safe; every step checks what is already in place
# and skips it. --force re-downloads the browser, reinstalls npm, and rewrites
# the config. --status prints a checklist.
#
# ENV OVERRIDES
#   CDP_HEADLESS_SHELL  path to the runner wrapper (default ~/.cache/ms-playwright/headless-shell-<rev>/headless-shell-runner.sh)
#   CDP_PORT            CDP port (default 9222)
#   CDP_USER_DATA_DIR   browser profile dir (default ~/.cdp-headless)
#   CHROME_MCP_DIR      npm install dir (default ~/workspace/chrome-mcp)
#   GLIBC_PREFIX        Termux glibc rootfs (default $PREFIX/glibc)
#   PLAYWRIGHT_CACHE    browser cache dir (default ~/.cache/ms-playwright)
#
# EXIT: 0 = all good; 1 = something could not be ensured.
# =============================================================================
set -uo pipefail

# --- skill-relative paths ----------------------------------------------------
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_CDP="$SKILL_DIR/scripts/start-cdp.sh"

# --- user paths (overridable) ------------------------------------------------
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
CHROME_MCP_DIR="${CHROME_MCP_DIR:-$HOME/workspace/chrome-mcp}"
MCP_CONFIG="${MCP_CONFIG:-$HOME/.pi/agent/mcp.json}"
PLAYWRIGHT_CACHE="${PLAYWRIGHT_CACHE:-$HOME/.cache/ms-playwright}"
GLIBC_PREFIX="${GLIBC_PREFIX:-$PREFIX/glibc}"

# Playwright 1.62.x pins chromium headless-shell revision 1234 (Chromium 151).
# Playwright DOES publish prebuilt arm64 builds for every browser (this is the
# answer to "does Playwright have a prebuilt android arm64 binary?"): both
# chromium-headless-shell-linux-arm64.zip and chromium-linux-arm64.zip exist on
# the CDN. They are glibc binaries — that is the real problem on Termux native.
#
# NOTE: we download the zip directly instead of `npx playwright install
# headless-shell`. The CLI downloads the identical artifact from the same CDN
# for the same revision (1.62.x -> rev 1234), but the download is the easy
# part: the binary still cannot run on bionic until the glibc shim below
# (patchelf, compat libc.so, runner wrapper, deps) is applied. Calling the CLI
# adds an npm dependency and registry logic for zero benefit. If you ever want
# a different Chromium, override HS_REV (look up the rev in
# playwright-core/browsers.json of the version you care about).
HS_REV="${HS_REV:-1234}"
HS_URL="https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/$HS_REV/chromium-headless-shell-linux-arm64.zip"
HS_DIR="$PLAYWRIGHT_CACHE/headless-shell-$HS_REV"
HS_BIN="$HS_DIR/chrome-linux/headless_shell"          # NOTE: zip layout is chrome-linux/, not flat
HS_RUNNER="${CDP_HEADLESS_SHELL:-$HS_DIR/headless-shell-runner.sh}"

CHROME_DEVTOOLS_PKG="chrome-devtools-mcp@1.6.0"
MCP_SERVER="$CHROME_MCP_DIR/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"

MODE="ensure"
[[ "${1:-}" == "--force" ]] && MODE="force"
[[ "${1:-}" == "--status" ]] && MODE="status"

say()  { printf '%b\n' "$*"; }
fail() { say "ERROR: $*" >&2; exit 1; }
ok()   { say "  \u2713 $*"; }
skip() { say "  - $* (already in place)"; }

# ---------------------------------------------------------------------------
# Environment detection: Termux native (bionic, needs glibc shim) vs proot
# (native glibc, runs the prebuilt binary as-is).
# ---------------------------------------------------------------------------
GLIBC_SHIM=0
if [[ -d "$GLIBC_PREFIX/lib" ]] && [[ -x "$GLIBC_PREFIX/lib/ld-linux-aarch64.so.1" ]]; then
  GLIBC_SHIM=1
fi
if [[ "$GLIBC_SHIM" == "1" ]]; then
  say "== mode: Termux native (bionic) + glibc shim =="
else
  say "== mode: glibc environment (proot-distro / container) — no shim needed =="
fi

# ---------------------------------------------------------------------------
# Tool prerequisites (Termux-native mode)
# ---------------------------------------------------------------------------
ensure_tools() {
  command -v curl >/dev/null 2>&1 || apt-get install -y --no-install-recommends curl >/dev/null 2>&1
  command -v unzip >/dev/null 2>&1 || apt-get install -y --no-install-recommends unzip >/dev/null 2>&1
  command -v dpkg-deb >/dev/null 2>&1 || apt-get install -y --no-install-recommends dpkg >/dev/null 2>&1
  if [[ "$GLIBC_SHIM" == "1" ]]; then
    command -v patchelf >/dev/null 2>&1 || apt-get install -y --no-install-recommends patchelf >/dev/null 2>&1
    if ! command -v glibc-runner >/dev/null 2>&1 || ! command -v apt-get >/dev/null 2>&1; then
      fail "glibc-runner missing. Enable the Termux glibc repo first:  pkg install glibc-repo && pkg update && pkg install glibc glibc-runner"
    fi
  fi
}

# ---------------------------------------------------------------------------
# glibc runtime deps: -glibc packages from the Termux glibc repo (apt) +
# NSS/ATK/udev/atspi/XRes/sqlite from Ubuntu/Debian arm64 debs (not in repo).
# ---------------------------------------------------------------------------
# apt packages verified to make headless-shell (Chromium 151) run + render:
GLIBC_APT_DEPS="
  glib-glibc fontconfig-glibc freetype-glibc libdrm-glibc mesa-glibc
  libx11-glibc libxcb-glibc libxau-glibc libxdmcp-glibc libxext-glibc libxrender-glibc
  libxcomposite-glibc libxfixes-glibc libxrandr-glibc libxkbcommon-glibc libxi-glibc
  libxss-glibc libice-glibc libsm-glibc libexpat-glibc libpng-glibc openssl-glibc
  harfbuzz-glibc libcairo-glibc pango-glibc dbus-glibc alsa-lib-glibc libsqlite-glibc
  ttf-dejavu-glibc
"
# .debs not packaged in the glibc repo (glibc-linked, compatible with any
# modern glibc >= 2.35 — this box ships 2.43). Ubuntu ports + Debian mirrors.
declare -a DEB_LIBS=(
  # name | URL | marker lib that proves it is installed
  "libnspr4|http://ports.ubuntu.com/pool/main/n/nspr/libnspr4_4.36-1ubuntu2_arm64.deb|libnspr4.so"
  "libnss3|http://ports.ubuntu.com/pool/main/n/nss/libnss3_3.98-1ubuntu0.2_arm64.deb|libnss3.so"
  "libatk|http://ports.ubuntu.com/pool/main/a/atk1.0/libatk1.0-0_2.36.0-3build1_arm64.deb|libatk-1.0.so.0"
  "libxdamage|https://deb.debian.org/debian/pool/main/libx/libxdamage/libxdamage1_1.1.6-1_arm64.deb|libXdamage.so.1"
  "libudev|https://deb.debian.org/debian/pool/main/s/systemd/libudev1_257.13-1~deb13u1_arm64.deb|libudev.so.1"
  "libatspi|https://deb.debian.org/debian/pool/main/a/at-spi2-core/libatspi2.0-0t64_2.61.1-1_arm64.deb|libatspi.so.0"
  "libxres|https://deb.debian.org/debian/pool/main/libx/libxres/libxres1_1.2.1-1_arm64.deb|libXRes.so.1"
)

ensure_glibc_deps() {
  say "Installing glibc runtime deps for headless-shell..."
  # 1) repo packages (apt) — skip if a representative set already present
  if [[ -f "$GLIBC_PREFIX/lib/libglib-2.0.so.0" ]] && [[ -f "$GLIBC_PREFIX/lib/libfontconfig.so.1" ]] \
     && [[ -f "$GLIBC_PREFIX/lib/libasound.so.2" ]] && [[ -f "$GLIBC_PREFIX/lib/libsqlite3.so.0" ]] \
     && [[ -f "$GLIBC_PREFIX/lib/libX11.so.6" ]] && [[ -d "$GLIBC_PREFIX/share/fonts/TTF" ]]; then
    skip "glibc repo deps"
  else
    apt-get update >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    apt-get install -y --no-install-recommends $GLIBC_APT_DEPS >/dev/null 2>&1 \
      || fail "apt install of glibc deps failed — is the glibc repo enabled? (pkg install glibc-repo && pkg update)"
    ok "glibc repo deps"
  fi
  # 2) deb-only libs — per-lib idempotent
  local WORK
  WORK="$(mktemp -d "${TMPDIR:-$HOME/.cache}/cdp-debs.XXXXXX")" 2>/dev/null || WORK="$HOME/.cache/cdp-debs"
  mkdir -p "$WORK"
  local entry name url marker
  for entry in "${DEB_LIBS[@]}"; do
    name="${entry%%|*}"; rest="${entry#*|}"; url="${rest%%|*}"; marker="${rest#*|}"
    if [[ -e "$GLIBC_PREFIX/lib/$marker" ]]; then
      skip "deb $name"
      continue
    fi
    say "Fetching $name from ${url%%pool*}"
    local deb="$WORK/$name.deb"
    for i in 1 2 3; do
      curl -fL --retry 4 --retry-delay 2 -o "$deb" "$url" 2>/dev/null && break
      sleep 2
    done
    [[ -s "$deb" ]] || fail "failed to download $name from $url"
    dpkg-deb -x "$deb" "$WORK/x-$name" 2>/dev/null || fail "bad deb: $name"
    # copy every .so* (incl. the nss/ module dir) into the glibc prefix
    local libdir
    libdir="$WORK/x-$name/usr/lib/aarch64-linux-gnu"
    if [[ -d "$libdir" ]]; then
      cp -a "$libdir"/lib*.so* "$GLIBC_PREFIX/lib/" 2>/dev/null || true
      [[ -d "$libdir/nss" ]] && mkdir -p "$GLIBC_PREFIX/lib/nss" && cp -a "$libdir/nss/." "$GLIBC_PREFIX/lib/nss/" 2>/dev/null || true
    fi
    [[ -e "$GLIBC_PREFIX/lib/$marker" ]] && ok "deb $name" || fail "deb $name: $marker not installed"
  done
}

# ---------------------------------------------------------------------------
# headless-shell: download, extract, patch for native exec, runner wrapper.
# Patching is REQUIRED on Termux native:
#   * interpreter -> glibc loader, rpath $ORIGIN/compat:$ORIGIN:$GLIBC_PREFIX/lib
#   * native exec makes /proc/self/exe point at headless_shell, so Chromium
#     finds icudtl.dat (ICU); via ld.so exec it resolves to the loader -> ICU
#     error "Invalid file descriptor".
#   * compat/libc.so -> libc.so.6: Chromium dlopens "libc.so" at runtime; the
#     glibc prefix's libc.so is a GNU ld linker script (invalid ELF at load).
#   * runner wrapper unsets bionic LD_PRELOAD (libtermux-exec shim needs
#     bionic's 'LIBC' version node — glibc loader cannot load it) and sets
#     LD_LIBRARY_PATH + FONTCONFIG_FILE/PATH (glibc fontconfig must use its own
#     config; bionic /etc/fonts has no fonts.conf -> Skia FATAL + blank renders).
# ---------------------------------------------------------------------------
patch_binary() {
  chmod +x "$HS_BIN"
  mkdir -p "$HS_DIR/chrome-linux/compat"
  ln -sf "$GLIBC_PREFIX/lib/libc.so.6" "$HS_DIR/chrome-linux/compat/libc.so"
  patchelf --set-interpreter "$GLIBC_PREFIX/lib/ld-linux-aarch64.so.1" \
           --set-rpath '$ORIGIN/compat:$ORIGIN:'"$GLIBC_PREFIX/lib" "$HS_BIN" 2>/dev/null \
    || fail "patchelf --set-interpreter failed on $HS_BIN"
  cat > "$HS_RUNNER" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
set -u
HS_DIR="\$(cd "\$(dirname "\$(readlink -f "\$0")")/chrome-linux" && pwd)"
unset LD_PRELOAD
export LD_LIBRARY_PATH="\$HS_DIR/compat:$GLIBC_PREFIX/lib"
export FONTCONFIG_FILE="$GLIBC_PREFIX/etc/fonts/fonts.conf"
export FONTCONFIG_PATH="$GLIBC_PREFIX/etc/fonts"
exec "\$HS_DIR/headless_shell" "\$@"
EOF
  chmod +x "$HS_RUNNER"
}

ensure_headless_shell() {
  if [[ -x "$HS_BIN" ]] && [[ -x "$HS_RUNNER" ]]; then
    if "$HS_RUNNER" --version >/dev/null 2>&1; then
      skip "headless-shell ($("$HS_RUNNER" --version 2>/dev/null))"
      return 0
    fi
    # binary exists but does not run (e.g. unpatched fresh extract) -> redo
    [[ "$MODE" == "force" ]] || say "headless-shell present but not runnable — repairing..."
  fi
  say "Downloading headless-shell (rev $HS_REV, arm64) — may take a few minutes..."
  mkdir -p "$PLAYWRIGHT_CACHE"
  rm -rf "$HS_DIR" "$HS_DIR.zip"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -fL -C - --retry 5 --retry-delay 3 -o "$HS_DIR.zip" "$HS_URL" 2>/dev/null || true
    SZ=$(stat -c%s "$HS_DIR.zip" 2>/dev/null || echo 0)
    [[ "$SZ" -ge 100000000 ]] && break
    sleep 2
  done
  if ! unzip -q -o "$HS_DIR.zip" -d "$HS_DIR" 2>/dev/null; then
    fail "failed to download/extract headless-shell from $HS_URL"
  fi
  if [[ "$GLIBC_SHIM" == "1" ]]; then
    patch_binary
    "$HS_RUNNER" --version >/dev/null 2>&1 \
      || fail "headless-shell does not run — missing glibc deps? (rerun with bash -x to debug)"
  fi
  ok "headless-shell: $("$HS_RUNNER" --version 2>/dev/null)"
}

# ---------------------------------------------------------------------------
# chrome-devtools-mcp npm package
# ---------------------------------------------------------------------------
ensure_npm() {
  if [[ -f "$MCP_SERVER" ]]; then
    skip "chrome-devtools-mcp ($(node -e "console.log(require('$CHROME_MCP_DIR/node_modules/chrome-devtools-mcp/package.json').version)" 2>/dev/null))"
  else
    say "Installing $CHROME_DEVTOOLS_PKG in $CHROME_MCP_DIR..."
    mkdir -p "$CHROME_MCP_DIR"
    (cd "$CHROME_MCP_DIR" && npm install --no-audit --no-fund "$CHROME_DEVTOOLS_PKG") || fail "npm install failed"
    ok "chrome-devtools-mcp installed"
  fi
}

# ---------------------------------------------------------------------------
# ~/.pi/agent/mcp.json — lazy lifecycle + cdp-lifecycle wrapper.
#
# lifecycle: "lazy" + idleTimeout make pi-mcp-adapter spawn the MCP server
# only when a browser tool is first called, and shut it down after the idle
# window. The cdp-lifecycle.sh wrapper ties headless Chrome's lifetime to the
# MCP server's: it ensures CDP is up before the server starts, and tears the
# whole Chrome tree down when the server exits (idle shutdown / crash / kill).
# Without the wrapper, the CDP_READY !command starts Chrome but nothing ever
# stops it — a lingering browser on a low-RAM box.
# ---------------------------------------------------------------------------
ensure_config() {
  mkdir -p "$(dirname "$MCP_CONFIG")"
  if [[ -f "$MCP_CONFIG" ]] && grep -q 'cdp-lifecycle' "$MCP_CONFIG" 2>/dev/null && [[ "$MODE" != "force" ]]; then
    skip "pi MCP config declares chrome-devtools via cdp-lifecycle (lazy)"
    return 0
  fi
  # The lifecycle wrapper lives next to this skill's start-cdp.sh.
  local lifecycle
  lifecycle="$SKILL_DIR/scripts/cdp-lifecycle.sh"
  if [[ ! -f "$lifecycle" ]]; then
    say "installing cdp-lifecycle.sh wrapper next to start-cdp.sh..."
    cp "$SKILL_DIR/../../scripts/cdp-lifecycle.sh" "$lifecycle" 2>/dev/null \
      || cp "$HOME/workspace/agent-skills/scripts/cdp-lifecycle.sh" "$lifecycle" 2>/dev/null \
      || die "could not locate cdp-lifecycle.sh to install"
    chmod +x "$lifecycle"
  fi
  cat > "$MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "bash",
      "args": [
        "$lifecycle",
        "$MCP_SERVER",
        "--browserUrl=http://127.0.0.1:${CDP_PORT:-9222}",
        "--headless=true",
        "--no-usage-statistics",
        "--no-performance-crux"
      ],
      "lifecycle": "lazy",
      "idleTimeout": 5
    }
  }
}
EOF
  ok "wrote $MCP_CONFIG (lazy MCP + cdp-lifecycle teardown)"
  say "NOTE: run /reload in pi to re-read the MCP config"
}

# ---------------------------------------------------------------------------
# Verification: CDP up, then a real render check (data: URL, green page,
# decode center pixel — proves fonts + compositing work, not just the socket).
# ---------------------------------------------------------------------------
verify_render() {
  say "Verifying render pipeline (green page -> center pixel)..."
  local script
  script="$(mktemp 2>/dev/null || echo "$HOME/.cache/cdp-render-check.js")"
  cat > "$script" <<'EOF'
const http=require('http'),zlib=require('zlib');
const port=process.env.CDP_PORT||9222;
function getJSON(p){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port,path:p},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
function centerRGB(buf){
  let off=8,w=0,h=0,ct=0;const idat=[];
  while(off<buf.length){const len=buf.readUInt32BE(off),t=buf.toString('ascii',off+4,off+8);
    if(t==='IHDR'){w=buf.readUInt32BE(off+8);h=buf.readUInt32BE(off+12);ct=buf[off+17];}
    if(t==='IDAT')idat.push(buf.slice(off+8,off+8+len));
    if(t==='IEND')break;off+=12+len;}
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const bpp=ct===2?3:4,stride=w*bpp;
  const out=Buffer.alloc(h*stride);let prev=Buffer.alloc(stride),pos=0;
  for(let y=0;y<h;y++){const ft=raw[pos++];
    for(let x=0;x<stride;x++){let v=raw[pos++],a=0,b=0,c=0;
      if(x>=bpp)a=out[y*stride+x-bpp]; b=prev[x]; if(x>=bpp)c=prev[x-bpp];
      if(ft===1)v=(v+a)&0xff; else if(ft===2)v=(v+b)&0xff; else if(ft===3)v=(v+((a+b)>>1))&0xff;
      else if(ft===4){const p1=Math.abs(b-c),p2=Math.abs(a-c),p3=Math.abs(a+b-2*c);v=(v+((p1<=p2&&p1<=p3)?a:(p2<=p3?b:c)))&0xff;}
      out[y*stride+x]=v;}
    prev=out.slice(y*stride,(y+1)*stride);}
  const cx=Math.floor(w/2)*bpp;return [out[cx],out[cx+1],out[cx+2]];}
(async()=>{
  const list=await getJSON('/json/list');
  const page=list.find(t=>t.type==='page')||list[0];
  const ws=new WebSocket(page.webSocketDebuggerUrl);let id=0;const pend=new Map();
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws failed'));});
  const send=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
  await send('Page.enable');
  await send('Page.navigate',{url:'data:text/html,<body style="background:%2300cc00"><h1>ok</h1></body>'});
  await new Promise(r=>setTimeout(r,2500));
  const s=await send('Page.captureScreenshot',{format:'png'});
  const rgb=centerRGB(Buffer.from(s.result.data,'base64'));
  console.log('center RGB:',rgb.join(','));
  ws.close();process.exit((rgb[1]>150&&rgb[0]<120&&rgb[2]<120)?0:1);
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
EOF
  if CDP_PORT="${CDP_PORT:-9222}" node "$script" 2>/dev/null; then
    ok "render check: green page painted (fonts + compositor OK)"
  else
    fail "render check failed — browser not painting. See troubleshooting in SKILL.md"
  fi
}

# ===========================================================================
# --status
# ===========================================================================
if [[ "$MODE" == "status" ]]; then
  say "== Chrome DevTools MCP (pi) status =="
  if [[ -x "$HS_BIN" ]] && [[ -x "$HS_RUNNER" ]]; then
    ok "headless-shell: $("$HS_RUNNER" --version 2>/dev/null)"
    if [[ "$GLIBC_SHIM" == "1" ]]; then
      [[ -f "$HS_DIR/chrome-linux/compat/libc.so" ]] && ok "compat libc.so shim present" || skip "compat libc.so shim missing"
      for entry in "${DEB_LIBS[@]}"; do
        marker="${entry#*|*}"; marker="${marker#*|}"
        [[ -e "$GLIBC_PREFIX/lib/$marker" ]] || skip "deb lib $marker"
      done
    fi
  else
    skip "headless-shell missing"
  fi
  [[ -f "$MCP_SERVER" ]] && ok "chrome-devtools-mcp installed" || skip "chrome-devtools-mcp missing"
  [[ -x "$START_CDP" ]] && ok "start-cdp.sh present" || skip "start-cdp.sh missing"
  if [[ -f "$MCP_CONFIG" ]] && grep -q 'cdp-lifecycle' "$MCP_CONFIG" 2>/dev/null; then
    ok "pi MCP config declares chrome-devtools via cdp-lifecycle (lazy)"
  else
    skip "pi MCP config missing chrome-devtools/cdp-lifecycle"
  fi
  if curl -fsS --max-time 2 "http://127.0.0.1:${CDP_PORT:-9222}/json/version" >/dev/null 2>&1; then
    ok "CDP up on 127.0.0.1:${CDP_PORT:-9222}"
  else
    skip "CDP down (run scripts/start-cdp.sh)"
  fi
  exit 0
fi

# ===========================================================================
# main install
# ===========================================================================
say "== Chrome DevTools MCP (pi) setup =="
ensure_tools
[[ "$GLIBC_SHIM" == "1" ]] && ensure_glibc_deps
ensure_headless_shell
ensure_npm
[[ -x "$START_CDP" ]] || fail "start-cdp.sh missing at $START_CDP — it lives in this skill"
ensure_config
say "Ensuring CDP is up on 127.0.0.1:${CDP_PORT:-9222}..."
if [[ "$MODE" == "force" ]]; then bash "$START_CDP" --force; else bash "$START_CDP"; fi
verify_render

say ""
say "Done. chrome-devtools MCP is ready."
say "  - Browser:  $HS_BIN (patchelf'd; launch via $HS_RUNNER)"
say "  - CDP:      http://127.0.0.1:${CDP_PORT:-9222}"
say "  - Launcher: $START_CDP"
say "  - Config:   $MCP_CONFIG"
say "  - Next:     run /reload in pi, then mcp({ search: \"navigate\" })"
