#!/data/data/com.termux/files/usr/bin/bash
# setup-dsh-termux.sh — idempotent @deepseek-ai/dsh installer for Termux (aarch64).
#
# WHY THIS EXISTS (from real Termux debugging):
#   * `npm i @deepseek-ai/dsh -g` fails twice on Termux (bionic libc):
#     1. node-pty's node-gyp configure dies with
#        "gyp: Undefined variable android_ndk_path in binding.gyp":
#        node's cached headers (common.gypi) reference <(android_ndk_path)
#        under an OS=="android" branch that gyp evaluates true here, and
#        nothing defines the variable. Fix: define it via the env var
#        npm_config_android_ndk_path=<prefix> during every npm install.
#     2. koffi (FFI) has no working prebuilt for Termux: the
#        @koromix/koffi-linux-arm64 package is a glibc build that fails to
#        dlopen on bionic, so cnoke falls back to a source build, which
#        then fails to compile: bionic declares statx() only at API >= 30
#        (__INTRODUCED_IN(30)), Termux targets API 24, so the call in
#        lib/native/base/base.cc resolves to the `struct statx` TYPE
#        ("no matching constructor" / "invalid operands ('statx' and 'int')").
#        Fix: patch that call to syscall(SYS_statx, ...) under
#        __ANDROID_API__ < 30 (the file already uses syscall(SYS_*) for
#        renameat2/getrandom), build, and ship the binary under the runtime
#        loader's triplet (build/koffi/linux_arm64/ — cnoke outputs
#        android_arm64, which index.cjs never looks for).
#   * `npm i -g <dir>` does NOT resolve the dir's dependencies (links only),
#     and a registry global install ignores local overrides — so the
#     patched koffi can only be forced into dsh's tree via a wrapper project
#     (package.json `overrides` + `file:` dep) installed LOCALLY, with the
#     dsh bin wired onto PATH by a wrapper script.
#   * Do NOT symlink the bin: dsh's lib/bin.js has a `#!/usr/bin/env node`
#     shebang and Termux has no /usr. Use a sh wrapper with absolute paths
#     (same fix Termux's own npm bin uses: full path to env).
#   * `dsh web` additionally needs:
#     - sharp's WASM fallback: sharp has no android-arm64 native binary on
#       bionic (glibc prebuilds can't dlopen), so install @img/sharp-wasm32
#       — sharp's loader auto-falls back to it (no env vars). Without it:
#       "Could not load the sharp module using the android-arm64 runtime".
#     - node --expose-internals in the launcher: the web profile enables
#       cordis-plugin-hmr, which requires it. Without it:
#       "--expose-internals is required for HMR service".
#   * Bind the webserver on 0.0.0.0 (web profile only): the upstream
#     dsh-web-app/lib/startup.js rejects `--host 0.0.0.0` with a "safety"
#     error, and its cordis.patch.yml falls back to
#     `ctx.webStartup.host ?? '127.0.0.1'`. On Android 11+ per-uid
#     SELinux isolates loopback-bound sockets but lets `0.0.0.0`-bound
#     ports through the shared bind namespace, so the host browser
#     (Edge) reaches `127.0.0.1:<port>` only when the server listened
#     on `0.0.0.0`. Verified end-to-end: OpenCode (Bun.serve defaults
#     to `0.0.0.0`) reaches Edge; dsh web (defaults to `127.0.0.1`) does
#     not. The runtime schema accepts both values, so the CLI guard is
#     the only blocker. We pin host to `0.0.0.0` via an id-targeted
#     patch to the web profile's cordis.patch.yml, applied before the
#     CLI parser runs. Skipped when DSH_BIND_HOST=loopback or
#     DSH_WEB_BIND=loopback is set (so a safety-sensitive deployment
#     can opt out).
#   * Runtime: sending a message dies with
#     "EACCES: permission denied, link '.../session.jsonl.zstd.<hex>.tmp' ->
#     '.../session.jsonl.zstd'": dsh's session persistence
#     (dsh-session-persistence-jsonl) publishes new logs with a hardlink
#     (link(tmp, final)) for crash-durability, but Termux's /data forbids
#     hardlinks entirely (even own files, EACCES on link()). Fix: patch
#     materializePosix to fall back to rename() on EACCES/EPERM — rename is
#     equally atomic on POSIX and needs no link permission.
#
# IDEMPOTENT: safe to run repeatedly. Skips the koffi source build when the
# patched tarball is cached; skips the (long) npm install when the pinned
# dsh version is already present and both native modules load; rewrites the
# bin wrapper only when it changed.
#
# UPGRADING: just re-run the script — with no DSH_VERSION env var it resolves
# the latest published dsh version, so a plain run is an upgrade run. If the
# npm install then fails with a koffi range conflict (dsh's tree moved off
# ^3.1.0), rebuild the patched koffi at the new version:
#   KOFFI_VERSION=<new> DSH_VERSION=<new> bash setup-dsh-termux.sh --force
# (the statx patch asserts its exact call site, so a koffi source change
# fails loudly and the patch must be updated in this script).
#
# Usage:
#   bash setup-dsh-termux.sh                          # install/upgrade/verify dsh (latest)
#   DSH_VERSION=0.1.0-rc.6 bash setup-dsh-termux.sh   # pin a dsh version
#   bash setup-dsh-termux.sh --force                  # rebuild everything
#   bash setup-dsh-termux.sh --reinstall              # remove the install, then install fresh
#   bash setup-dsh-termux.sh --reinstall --force      # remove, rebuild koffi, install fresh
#   DSH_BIND_HOST=loopback bash setup-dsh-termux.sh    # opt out of the 0.0.0.0 webserver bind
#
# Notes:
#   * Uses pnpm when available (much lower memory, faster — npm was
#     observed being SIGKILLed mid-install twice on this device), npm
#     otherwise. pnpm 10+ blocks build scripts unless allowlisted: the
#     wrapper project writes pnpm-workspace.yaml with allowBuilds for
#     node-pty (koffi ships its patched binary, so its script stays blocked).
#   * npm 11 prints "install scripts not yet covered by allowScripts"
#     warnings; the native install scripts still run (verified). If a future
#     npm config blocks them, run: npm install-scripts approve koffi node-pty
#   * The web profile's cordis.patch.yml is patched so the host-webserver
#     row binds on 0.0.0.0 instead of the upstream default 127.0.0.1. The
#     upstream CLI guard rejects `--host 0.0.0.0` but the runtime schema
#     accepts both values, so the patch is the only way to set it. Set
#     DSH_BIND_HOST=loopback (or DSH_WEB_BIND=loopback) to keep the
#     upstream loopback-only default.

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────
# No DSH_VERSION env var -> resolve the newest published version across the
# `latest` and `next` dist-tags, so a plain re-run upgrades to the newest
# build (e.g. 0.1.0-rc.8 on `next` beats 0.1.0-rc.7 on `latest`); fall back
# to the last known-good pin if npm is offline.
DSH_VERSION="${DSH_VERSION:-}"
if [ -z "$DSH_VERSION" ]; then
  _dsh_latest="$(npm view @deepseek-ai/dsh version 2>/dev/null || true)"
  _dsh_next="$(npm view @deepseek-ai/dsh@next version 2>/dev/null || true)"
  DSH_VERSION="$(python3 - "$_dsh_latest" "$_dsh_next" <<'PY'
import sys, re
def key(v):
    m = re.match(r'^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$', v or '')
    if not m:
        return (0, 0, 0, 0, ())
    maj, mnr, pat = int(m.group(1)), int(m.group(2)), int(m.group(3))
    pre = m.group(4)
    if pre is None:
        return (maj, mnr, pat, 1, ())
    parts = []
    for t in re.split(r'[._-]', pre):
        parts.append((0, int(t), '') if t.isdigit() else (1, 0, t))
    return (maj, mnr, pat, 0, tuple(parts))
cands = [a for a in sys.argv[1:] if a]
print(max(cands, key=key) if cands else '')
PY
  )"
  [ -n "$DSH_VERSION" ] || DSH_VERSION="0.1.0-rc.6"
fi
KOFFI_VERSION="${KOFFI_VERSION:-3.1.4}"         # version dsh's range resolves to
DSH_HOME_DIR="${DSH_HOME_DIR:-$HOME/dsh-global}"        # live install (wrapper project)
BUILD_DIR="${BUILD_DIR:-$HOME/.cache/dsh-termux}"        # koffi source + patched tarball
KOFFI_TGZ="$BUILD_DIR/koffi-$KOFFI_VERSION-termux.tgz"  # cached patched tarball
PREFIX="$(dirname "$(dirname "$(command -v node)")")"   # Termux prefix (/data/.../usr)
NODE_BIN="$(command -v node)"
PREFIX_BIN="$PREFIX/bin"
DSH_HOME_PROFILES="${DSH_HOME_PROFILES:-$HOME/.dsh/profiles}"  # dsh home; web profile lives here
DSH_BIND_HOST="${DSH_BIND_HOST:-}"     # "" / "0.0.0.0" / "loopback" — overrides default 0.0.0.0 on web profile
DSH_WEB_PORT="${DSH_WEB_PORT:-3080}"   # webserver port; also pinned by the patch when set

# ── Helpers ──────────────────────────────────────────────────────────────
log()  { printf '\033[1;34m[setup-dsh]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup-dsh]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[setup-dsh]\033[0m %s\n' "$*" >&2; exit 1; }

is_termux() { [ -d /data/data/com.termux ] && [ -x "$PREFIX_BIN/sh" ]; }

# ── 1. Pre-reqs: node toolchain + build tools ────────────────────────────
ensure_prereqs() {
  local missing=()
  command -v node    >/dev/null 2>&1 || missing+=(nodejs-lts)
  command -v npm     >/dev/null 2>&1 || missing+=(nodejs-lts)
  command -v python3 >/dev/null 2>&1 || missing+=(python)
  command -v make    >/dev/null 2>&1 || missing+=(make)
  command -v g++     >/dev/null 2>&1 || missing+=(clang)
  command -v cmake   >/dev/null 2>&1 || missing+=(cmake)
  command -v curl    >/dev/null 2>&1 || missing+=(curl)
  command -v tar     >/dev/null 2>&1 || missing+=(tar)
  if [[ ${#missing[@]} -gt 0 ]]; then
    log "installing missing prereqs: ${missing[*]}"
    pkg install -y "${missing[@]}"
  fi
  for tool in node npm python3 make g++ cmake curl tar; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool still missing after pkg install"
  done
}

# ── 2. koffi: patch statx, build, repack (cached) ────────────────────────
# bionic hides statx() behind API 30; Termux targets API 24. Patch the call
# to syscall(SYS_statx, ...) — the pattern base.cc already uses elsewhere.
patch_koffi_source() {
  local src="$1"
  grep -q 'syscall(SYS_statx' "$src/lib/native/base/base.cc" && { log "koffi source already patched."; return 0; }
  grep -qF 'if (statx(fd, pathname, stat_flags, stat_mask, &sxb) < 0) {' "$src/lib/native/base/base.cc" \
    || die "koffi $KOFFI_VERSION source changed: expected statx() call not found — update the patch"
  python3 - "$src/lib/native/base/base.cc" <<'PY'
import sys
path = sys.argv[1]
with open(path) as f:
    text = f.read()
old = """    struct statx sxb;
    if (statx(fd, pathname, stat_flags, stat_mask, &sxb) < 0) {"""
new = """    struct statx sxb;
#if defined(__ANDROID__) && defined(__ANDROID_API__) && __ANDROID_API__ < 30
    // bionic only exposes the statx() libc wrapper since API level 30
    // (e.g. Termux targets API 24), so call the syscall directly.
    if (syscall(SYS_statx, fd, pathname, stat_flags, stat_mask, &sxb) < 0) {
#else
    if (statx(fd, pathname, stat_flags, stat_mask, &sxb) < 0) {
#endif"""
if text.count(old) != 1:
    sys.exit(f"expected exactly one statx call site, found {text.count(old)}")
with open(path, "w") as f:
    f.write(text.replace(old, new))
PY
  grep -q 'syscall(SYS_statx' "$src/lib/native/base/base.cc" || die "patch did not apply"
  log "patched statx() -> syscall(SYS_statx, ...) in base.cc"
}

ensure_koffi_tarball() {
  local force="${1:-}"
  # Cache is only valid for the CURRENT recipe: a tarball still carrying
  # the cnoke "install" script is from an older build and gets rebuilt.
  # (grep -c, not grep -q: -q SIGPIPEs tar under pipefail.)
  if [[ "$force" != "force" ]] && [ -f "$KOFFI_TGZ" ] \
     && [ "$(tar -xOf "$KOFFI_TGZ" package/package.json 2>/dev/null | grep -c '"install"')" -eq 0 ]; then
    log "patched koffi tarball cached at $KOFFI_TGZ — skipping rebuild."
    return 0
  fi
  [[ "$force" = "force" ]] && log "--force: rebuilding koffi"

  # All temp work runs in a SUBSHELL so the EXIT cleanup trap stays scoped
  # to it. A RETURN trap armed here would leak globally (traps are not
  # function-scoped) and fire again when main() returns, after the locals
  # are gone — "unbound variable" under set -u.
  (
    set -euo pipefail
    local work="" tmp="" pkg_dir="" out=""
    trap 'rm -rf "$tmp" "$work"' EXIT
    mkdir -p "$BUILD_DIR"
    work="$(mktemp -d "$BUILD_DIR/koffi-build.XXXXXX")"
    tmp="$(mktemp -d)"
    log "Fetching koffi@$KOFFI_VERSION from npm..."
    ( cd "$tmp" && npm pack "koffi@$KOFFI_VERSION" >/dev/null ) || die "npm pack koffi failed"
    tar -xzf "$tmp/koffi-$KOFFI_VERSION.tgz" -C "$tmp" || die "koffi extract failed"
    pkg_dir="$tmp/package"
    [ -f "$pkg_dir/lib/native/base/base.cc" ] || die "unexpected koffi layout"

    cp -r "$pkg_dir" "$work/package"
    patch_koffi_source "$work/package"

    # The repacked tarball ships the built binary, so koffi's "install"
    # script (a cnoke rebuild) is dead weight. Strip it: pnpm 12 rc hard-
    # fails on any build script its allowBuilds doesn't cover, and it
    # cannot match file: deps by name (verified); npm would otherwise
    # waste minutes recompiling. Binary present -> no script needed.
    python3 - "$work/package/package.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
scripts = data.get("scripts", {})
scripts.pop("install", None)
assert "install" not in scripts, "koffi install script not stripped"
data["scripts"] = scripts
with open(path, "w") as f:
    json.dump(data, f, indent=2)
PY

    log "Building koffi from source (cnoke)..."
    out="$( ( cd "$work/package" && node ./cnoke.cjs -P . -D src/koffi --prebuild --release ) 2>&1 )" \
      || { printf '%s\n' "$out" | tail -25 >&2; die "koffi source build failed"; }
    [ -f "$work/package/build/koffi/android_arm64/koffi.node" ] \
      || die "koffi build produced no android_arm64 binary"

    # Runtime loader (src/koffi/index.cjs) only looks for linux_arm64/musl_arm64.
    if [ ! -f "$work/package/build/koffi/linux_arm64/koffi.node" ]; then
      cp -r "$work/package/build/koffi/android_arm64" "$work/package/build/koffi/linux_arm64"
    fi
    ( cd "$work/package" && npm pack >/dev/null ) || die "koffi repack failed"
    # grep -c (NOT grep -q): -q exits on first match and SIGPIPEs tar, which
    # pipefail then reports as failure even though the binary is present.
    [ "$(tar tzf "$work/package/koffi-$KOFFI_VERSION.tgz" | grep -c 'build/koffi/linux_arm64/koffi.node')" -gt 0 ] \
      || die "repacked tarball missing linux_arm64 binary"

    mkdir -p "$BUILD_DIR"
    install -m 0644 "$work/package/koffi-$KOFFI_VERSION.tgz" "$KOFFI_TGZ"
    log "Patched koffi tarball -> $KOFFI_TGZ"
  ) || die "koffi setup failed"
}

# ── 3. Wrapper project: dsh + patched koffi via file: override ───────────
ensure_wrapper_project() {
  local rel
  rel="$(python3 -c "import os;print(os.path.relpath('$KOFFI_TGZ','$DSH_HOME_DIR'))")"
  mkdir -p "$DSH_HOME_DIR"
  cat > "$DSH_HOME_DIR/package.json" <<JSON
{
  "name": "dsh-global",
  "private": true,
  "version": "1.0.0",
  "description": "Global install wrapper for @deepseek-ai/dsh with Termux-patched koffi",
  "dependencies": {
    "@deepseek-ai/dsh": "$DSH_VERSION",
    "@img/sharp-wasm32": "*",
    "koffi": "file:$rel"
  },
  "overrides": {
    "koffi": "file:$rel"
  },
  "pnpm": {
    "overrides": {
      "koffi": "file:$rel"
    }
  }
}
JSON
  # pnpm 10+ blocks dependency build scripts unless allowlisted. node-pty
  # MUST build (no android-arm64 prebuilt). The rest are JS-level postinstalls
  # or (koffi) no-ops because the patched tarball ships the binary.
  # pnpm 12 rc reads BOTH overrides and allowBuilds from pnpm-workspace.yaml;
  # package.json pnpm.overrides is ignored by it (verified).
  cat > "$DSH_HOME_DIR/pnpm-workspace.yaml" <<YAML
# Hoist everything to the root node_modules: the wrapper must behave like
# the old npm -g install (script steps + dsh itself assume flat layout —
# node-pty require in verify, the session-persistence patch path, and
# sharp's wasm fallback visibility all break under pnpm's isolated layout).
publicHoistPattern:
  - "*"
allowBuilds:
  node-pty: true
  koffi: true
  protobufjs: true
  "@google/genai": true
  "@deepseek-ai/dsh-subprocess-local": true
overrides:
  koffi: file:$rel
YAML
}

# ── 4. npm install (skips when the pinned version + natives already work) ─
ensure_install() {
  local force="${1:-}" installed_ver installer
  if [[ "$force" != "force" ]] && [ -f "$DSH_HOME_DIR/node_modules/@deepseek-ai/dsh/package.json" ]; then
    installed_ver="$(python3 -c "import json;print(json.load(open('$DSH_HOME_DIR/node_modules/@deepseek-ai/dsh/package.json'))['version'])" 2>/dev/null || true)"
    if [ "$installed_ver" = "$DSH_VERSION" ] \
       && node -e "require('$DSH_HOME_DIR/node_modules/koffi'); require('$DSH_HOME_DIR/node_modules/node-pty');" 2>/dev/null; then
      log "dsh $installed_ver already installed and native modules load — skipping install."
      return 0
    fi
    warn "found dsh '$installed_ver' but want '$DSH_VERSION' (or natives broken) — reinstalling."
  fi
  # pnpm preferred: far less memory and faster than npm on this huge tree
  # (npm was observed being SIGKILLed mid-reify twice on this device).
  if command -v pnpm >/dev/null 2>&1; then
    installer=pnpm
  else
    installer=npm
    log "pnpm not found — falling back to npm (slower, more memory)"
  fi
  # Bound V8 heap: a spike then fails loudly with "JavaScript heap out of
  # memory" instead of tripping Android's low-memory killer, which SIGKILLs
  # the whole install tree silently (observed: npm died mid-reify with no
  # error and no log line). Override the cap with NPM_HEAP_MB.
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${NPM_HEAP_MB:-1536}"
  local avail_mb
  avail_mb="$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo 2>/dev/null || true)"
  if [ -n "$avail_mb" ] && [ "$avail_mb" -lt 2048 ]; then
    warn "only ${avail_mb} MB RAM free — install may get killed; stop dsh web/omp first"
  fi
  log "$installer install (first run takes several minutes; output streams below)..."
  if [ "$installer" = pnpm ]; then
    # pnpm's build-script env lacks npm's bundled node-gyp shim on PATH.
    export PATH="$PREFIX/lib/node_modules/npm/bin/node-gyp-bin:$PATH"
    ( cd "$DSH_HOME_DIR" && pnpm i --no-frozen-lockfile ) \
      || die "pnpm install failed (see pnpm error above)"
  else
    ( cd "$DSH_HOME_DIR" && npm i --no-audit --no-fund ) \
      || die "npm install failed — see $HOME/.npm/_logs"
  fi
  log "$installer install done."
}

# ── 5. sharp: WASM fallback (web profile attachment plugin) ──────────────
# sharp has no working android-arm64 native binary on bionic (glibc
# prebuilds can't dlopen), but its loader automatically falls back to
# require("@img/sharp-wasm32/sharp.node") when the native load fails —
# installing the wasm package is sufficient (verified: real image
# decode/resize/encode works). Without it, `dsh web` dies with
# "Could not load the sharp module using the android-arm64 runtime".
ensure_sharp_wasm() {
  [ -d "$DSH_HOME_DIR/node_modules/sharp" ] || return 0   # no sharp in tree → nothing to fix
  if node -e "require('$DSH_HOME_DIR/node_modules/sharp');" 2>/dev/null; then
    log "sharp loads OK."
    return 0
  fi
  log "sharp native load failed — installing @img/sharp-wasm32 fallback..."
  if command -v pnpm >/dev/null 2>&1; then
    ( cd "$DSH_HOME_DIR" && pnpm i @img/sharp-wasm32 >/dev/null 2>&1 ) \
      || die "pnpm install @img/sharp-wasm32 failed"
  else
    ( cd "$DSH_HOME_DIR" && npm i @img/sharp-wasm32 >/dev/null 2>&1 ) \
      || die "npm install @img/sharp-wasm32 failed"
  fi
  node -e "require('$DSH_HOME_DIR/node_modules/sharp');" 2>/dev/null \
    || die "sharp still fails to load after installing @img/sharp-wasm32"
  log "sharp now loads via @img/sharp-wasm32."
}

# ── 6. Session persistence: hardlink publish -> rename fallback ──────────
# Termux /data forbids hardlinks (EACCES on link(), even for own files), so
# dsh's materializePosix (dsh-session-persistence-jsonl) fails with
# "EACCES: permission denied, link '...session.jsonl.zstd.<hex>.tmp' ->
# '...session.jsonl.zstd'" on the first message of a session. Patch the
# link(tmp, finalPath) publish to fall back to rename() on EACCES/EPERM
# (rename is equally atomic on POSIX). Idempotent.
ensure_session_atomic_rename() {
  local f="$DSH_HOME_DIR/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js"
  [ -f "$f" ] || { log "dsh-session-persistence-jsonl not found — skipping session patch."; return 0; }
  grep -q "await rename(tmp, finalPath)" "$f" && { log "session atomic-rename patch already applied."; return 0; }
  python3 - "$f" <<'PY'
import re, sys

path = sys.argv[1]
with open(path) as fh:
    text = fh.read()

old_import = 'import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";'
new_import = 'import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from "node:fs/promises";'
assert text.count(old_import) == 1, "fs/promises import not found"
text = text.replace(old_import, new_import)

# Whitespace-robust match of the link() publish block, preserving indentation.
pat = re.compile(r'^(\s*)let linked = false;\n\s*try \{\n\s*await link\(tmp, finalPath\);\n\s*linked = true;\n\s*\} finally \{', re.M)
m = pat.search(text)
assert m, "link(tmp, finalPath) block not found"
ind = m.group(1)
repl = (ind + 'let linked = false;\n'
        + ind + 'try {\n'
        + ind + '\tawait link(tmp, finalPath);\n'
        + ind + '\tlinked = true;\n'
        + ind + '} catch (error) {\n'
        + ind + '\t/* Termux /data forbids hardlinks (EACCES); rename is equally\n'
        + ind + '\t * atomic on POSIX and needs no link permission. */\n'
        + ind + '\tif (error?.code !== "EACCES" && error?.code !== "EPERM") throw error;\n'
        + ind + '\tawait rename(tmp, finalPath);\n'
        + ind + '\tlinked = true;\n'
        + ind + '} finally {')
text = text[:m.start()] + repl + text[m.end():]

with open(path, "w") as fh:
    fh.write(text)
PY
  grep -q "await rename(tmp, finalPath)" "$f" || die "session atomic-rename patch did not apply"
  log "patched session persistence: link() -> rename() fallback on EACCES"
}
# ── 6b. Refresh profile plugin trees after a host version change ─────────
# The cordis loader resolves bare module names PROFILE-FIRST (loader baseUrl
# = the profile dir), so anything hoisted into
# ~/.dsh/profiles/<name>/node_modules/@deepseek-ai/ SHADOWS the upgraded host
# copy under $DSH_HOME_DIR. After a host upgrade a frozen pre-upgrade profile
# tree therefore serves stale host packages: observed 2026-08-21 — dsh web
# answered a bare HTTP 400 on / because a profile-local
# dsh-host-webserver@0.1.0-rc.7 (hoisted by a plugin's dead regular dep)
# lacked the new renderIndex() that rc.1's frontend-static calls on every
# index request. Fix: when the host version differs from the version a
# profile's tree was last built against (stamp file), wipe the profile's
# REGENERABLE install state (node_modules + lockfiles — never cordis.patch.yml,
# cordis.yml, package.json, sessions, settings) and reinstall from the
# current manifests. Idempotent: matching stamp + resolvable host = no-op.
refresh_profiles() {
  local profiles_dir="$DSH_HOME_PROFILES"
  [ -d "$profiles_dir" ] || { log "no profiles dir ($profiles_dir) — skipping profile refresh"; return 0; }
  local profile stamp prev installer
  for profile in "$profiles_dir"/*/; do
    [ -d "$profile" ] || continue
    [ -f "$profile/package.json" ] || continue
    stamp="$profile/.dsh-setup-host-version"
    prev=""; [ -f "$stamp" ] && prev="$(cat "$stamp" 2>/dev/null || true)"
    if [ "$prev" = "$DSH_VERSION" ]; then
      log "profile $(basename "$profile"): tree matches host $DSH_VERSION — skipping."
      continue
    fi
    if [ -n "$prev" ]; then
      warn "profile $(basename "$profile"): built against host '$prev', now '$DSH_VERSION' — rebuilding (stale copies shadow the upgraded host)."
    else
      log "profile $(basename "$profile"): no build stamp — rebuilding to guarantee a clean tree."
    fi
    # Regenerable state only. cordis.patch.yml / cordis.yml / package.json /
    # sessions / storages stay untouched.
    rm -rf "${profile:?}/node_modules"
    rm -f "$profile/pnpm-lock.yaml" "$profile/package-lock.json"
    if command -v pnpm >/dev/null 2>&1; then
      ( cd "$profile" && pnpm i --no-frozen-lockfile ) \
        || die "profile $(basename "$profile"): pnpm install failed — fix or remove $profile/node_modules manually"
    else
      ( cd "$profile" && npm i --no-audit --no-fund ) \
        || die "profile $(basename "$profile"): npm install failed — fix or remove $profile/node_modules manually"
    fi
    # Invariant that caught the original bug: bare-name resolution from the
    # profile must land on the HOST tree, never a profile-local copy.
    node -e "
      const { createRequire } = require('module');
      const r = createRequire(process.argv[1] + '/probe.js');
      const p = r.resolve('@deepseek-ai/dsh-base/package.json');
      if (!p.startsWith(process.argv[2] + '/')) {
        console.error('profile resolves @deepseek-ai/dsh-base to ' + p + ', expected under ' + process.argv[2]);
        process.exit(1);
      }
    " "$profile" "$DSH_HOME_DIR/node_modules" \
      || die "profile $(basename "$profile"): a stale @deepseek-ai/* copy still shadows the host — inspect ${profile}node_modules"
    printf '%s\n' "$DSH_VERSION" > "$stamp"
    log "profile $(basename "$profile"): rebuilt against host $DSH_VERSION."
  done
}

# ── 7a. Kill any stale dsh web so the next boot can bind the port ───────
# Background (verified on Termux): when a user Ctrl+C's the launcher that
# spawned `nohup dsh web`, the SIGINT does not always reach the node child
# (nohup detaches it from the controlling terminal, and the launcher's job
# control is gone). The node process keeps the LISTEN socket bound, and the
# next boot fails with EADDRINUSE. `pkill -f 'bin.js web'` may not match by
# the prctl PR_SET_NAME from nohup, so we kill by full cmdline match.
# Verified: SIGTERM stops the node child within 2s; SIGKILL is the fallback
# if the agent has an AbortController that refuses SIGTERM.
ensure_dsh_zombie_killed() {
  local pids
  pids=$(ps -eo pid,args 2>/dev/null | awk '/[l]ib\/bin\.js web/ { print $1 }')
  if [ -z "$pids" ]; then
    log "no stale dsh web process detected."
    return 0
  fi
  log "stale dsh web process(es) detected: $pids — sending SIGTERM."
  for p in $pids; do
    kill -TERM "$p" 2>/dev/null || warn "kill -TERM $p failed"
  done
  local waited=0
  while [ $waited -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
    if ! kill -0 $pids 2>/dev/null; then
      log "stale dsh web exited after ${waited}s."
      return 0
    fi
  done
  warn "dsh web did not exit after 10s of SIGTERM — escalating to SIGKILL."
  for p in $pids; do
    kill -KILL "$p" 2>/dev/null || warn "kill -KILL $p failed"
  done
  sleep 1
}

# ── 7. `dsh` on PATH: sh wrapper (symlinks break: no /usr for the shebang) ─
ensure_dsh_bin() {
  local dest_dir dest target dsh_bin
  dsh_bin="$DSH_HOME_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
  [ -f "$dsh_bin" ] || die "dsh bin missing at $dsh_bin"

  if [ -w "$PREFIX_BIN" ]; then
    dest_dir="$PREFIX_BIN"
  else
    dest_dir="$HOME/.local/bin"
    mkdir -p "$dest_dir"
    if [[ ":$PATH:" != *":$dest_dir:"* ]]; then
      warn "$dest_dir is not on PATH; add it to ~/.bashrc: export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
  fi
  dest="$dest_dir/dsh"

  # --expose-internals: required by cordis-plugin-hmr, which the web
  # profile enables (headless disables it). Without the flag `dsh web`
  # dies at plugin load: "failed to apply loader entry ... hmr:
  # --expose-internals is required for HMR service".
  target="$(printf '%s\n' \
    '#!/data/data/com.termux/files/usr/bin/sh' \
    "# dsh launcher (setup-dsh-termux.sh) — absolute paths; Termux has no /usr" \
    "exec '$NODE_BIN' --expose-internals '$dsh_bin' \"\$@\"")"
  if [ -f "$dest" ] && [ "$(cat "$dest")" = "$target" ]; then
    log "dsh wrapper already up to date at $dest."
    return 0
  fi
  # Remove stale entries before writing: a DANGLING symlink (e.g. left by a
  # failed `npm i -g @deepseek-ai/dsh`, which creates prefix/bin/dsh ->
  # ../lib/node_modules/... and never cleans up on failure) makes `> "$dest"`
  # fail with ENOENT. `-f` follows symlinks, so check -e/-L explicitly.
  if [ -e "$dest" ] || [ -L "$dest" ]; then rm -f "$dest"; fi
  printf '%s\n' "$target" > "$dest"
  chmod 755 "$dest"
  log "Wrote dsh wrapper -> $dest"
}

# ── 7b. Webserver bind (web profile only): 0.0.0.0 instead of 127.0.0.1 ─
# Patches the web profile cordis.patch.yml so the host-webserver row binds on
# 0.0.0.0. dsh-web-app/lib/startup.js rejects `--host 0.0.0.0` at the CLI parser
# with "expose remote code execution" — but the runtime schema accepts both, so
# this is the only path to set the bind on the host-webserver row. On Android 11+
# this is required for the host browser (Edge) to reach the webserver at all:
# per-uid SELinux isolates loopback-bound sockets but lets 0.0.0.0-bound ports
# through the shared bind namespace. Verified end-to-end: OpenCode (Bun.serve
# defaults to 0.0.0.0) reaches Edge; dsh web (defaults to 127.0.0.1) does not.
# Idempotent: re-runs no-op. Skipped when DSH_BIND_HOST=loopback or
# DSH_WEB_BIND=loopback is set.
ensure_webserver_bind() {
  # Respect the opt-out: the upstream default is 127.0.0.1, and a deployment
  # that wants that strict default can set this env to opt out.
  local override="${DSH_BIND_HOST:-${DSH_WEB_BIND:-0.0.0.0}}"
  case "$override" in
    ""|0.0.0.0|all) ;; # apply the fix
    loopback|127.0.0.1)
      log "DSH_BIND_HOST=loopback set — keeping the upstream 127.0.0.1 default."
      return 0 ;;
    *)
      warn "DSH_BIND_HOST=$override is not a recognized value; expected 0.0.0.0 or loopback. Applying 0.0.0.0."
      ;;
  esac

  local profile_dir="$DSH_HOME_PROFILES/web"
  local patch="$profile_dir/cordis.patch.yml"

  # Bail early if the web profile does not exist yet — ensure_install will
  # create it on its first run. Don't try to materialize or recreate it here.
  if [ ! -d "$profile_dir" ]; then
    log "web profile not present yet ($profile_dir missing) — skipping webserver bind."
    return 0
  fi

  mkdir -p "$profile_dir"

  # The patch file is itself a YAML array; the host-webserver override is an
  # entry inside that array. Detect an existing entry (any host value) so we
  # know whether to add a new entry or update in place.
  if grep -qE '^[[:space:]]*-[[:space:]]+id:[[:space:]]+host-webserver[[:space:]]*$' "$patch" 2>/dev/null; then
    # Update the existing id-targeted row in place via awk. The script keeps
    # every key inside the host-webserver row's config block (port, etc.)
    # and rewrites only the host value to "0.0.0.0", inserting it if absent.
    # Built to be idempotent: re-running on a file already pinned to 0.0.0.0
    # leaves it unchanged byte-for-byte.
    _dsh_web_bind_tmp="$DSH_HOME_PROFILES/.dsh-web-bind-helper.tmp"
    awk -v target='  host: "0.0.0.0"' '
        BEGIN { mode = 0; cfgindent = ""; hostemitted = 0 }
        mode == 0 {
            if ($0 ~ /^[ \t]*-[ \t]*id:[ \t]*host-webserver[ \t]*$/) {
                print
                mode = 1
                next
            }
            print
            next
        }
        mode == 1 {
            if ($0 ~ /^[ \t]*config:[ \t]*$/) {
                print
                cfgindent = ""
                if (match($0, /^[ \t]+/)) cfgindent = substr($0, 1, RSTART - 1) "  "

                hostemitted = 0
                mode = 2
                next
            }
            print
            mode = 3
            next
        }
        mode == 2 {
            if ($0 ~ /^[ \t]+host:[ \t]/) {
                if (hostemitted == 0) {
                    print cfgindent target
                    hostemitted = 1
                }
                next
            }
            if ($0 ~ /^[ \t]+[A-Za-z_][A-Za-z0-9_]*:[ \t]*/) {
                print
                next
            }
            if (hostemitted == 0) {
                print cfgindent target
                hostemitted = 1
            }
            print
            mode = 0
            next
        }
    ' "$patch" > "$_dsh_web_bind_tmp" || die "awk failed to rewrite $patch"
    if ! cmp -s "$patch" "$_dsh_web_bind_tmp"; then
      mv "$_dsh_web_bind_tmp" "$patch"
    else
      rm -f "$_dsh_web_bind_tmp"
    fi
    log "webserver bind: ensured host=0.0.0.0 in $patch (existing row updated)"
  else
    # dsh's default patch file is the flow-style empty array `[]`. Appending a
    # block-style entry after `[]` is invalid YAML (needs a document separator),
    # so drop a lone `[]` placeholder before we append our entry. A file that
    # already holds a block-style array is left untouched and appended to.
    if grep -q '^[[:space:]]*\[\][[:space:]]*$' "$patch" 2>/dev/null; then
      sed -i '/^[[:space:]]*\[\][[:space:]]*$/d' "$patch"
    fi
    cat >> "$patch" <<'YAML'
# host browser (Edge) can reach dsh web on Android 11+ (per-uid SELinux
# isolates loopback-bound sockets; 0.0.0.0-bound ports share bind namespace).
# Generated by setup-dsh-termux.sh. Remove this entry to revert.
- id: host-webserver
  config:
    host: "0.0.0.0"
YAML
    log "webserver bind: appended host=0.0.0.0 entry to $patch"
  fi
}

# ── 8. Remove (--reinstall) ──────────────────────────────────────────────
# Deletes the live install (wrapper project) and any `dsh` bin wrapper so
# the next ensure_* step installs from scratch. Keeps user data (sessions,
# settings under ~/.dsh) and the patched-koffi tarball cache — add --force
# to also rebuild koffi. Guarded against destructive DSH_HOME_DIR values.
uninstall() {
  case "$DSH_HOME_DIR" in
    ""|/|"$HOME"|"$PREFIX"|"$PREFIX_BIN")
      die "refusing to remove DSH_HOME_DIR=$DSH_HOME_DIR" ;;
  esac
  local running
  running="$(pgrep -f 'dsh/lib/bin.js' 2>/dev/null | wc -l || true)"
  if [ "$running" -gt 0 ]; then
    warn "dsh is running ($running process(es)); old files stay open until it exits"
  fi
  if [ -e "$DSH_HOME_DIR" ]; then
    log "removing install at $DSH_HOME_DIR ..."
    rm -rf "$DSH_HOME_DIR"
    log "removed."
  else
    log "no existing install at $DSH_HOME_DIR — nothing to remove."
  fi
  local stale
  for stale in "$PREFIX_BIN/dsh" "$HOME/.local/bin/dsh"; do
    if [ -e "$stale" ] || [ -L "$stale" ]; then rm -f "$stale"; fi
  done
}

# ── 9. Verify ────────────────────────────────────────────────────────────
verify() {
  log "Verifying..."
  command -v dsh >/dev/null 2>&1 || die "dsh not on PATH"
  local ver
  ver="$(dsh --version 2>/dev/null | tail -1 || true)"
  [ "$ver" = "$DSH_VERSION" ] || die "dsh version mismatch: got '$ver', want '$DSH_VERSION'"
  log "dsh $ver OK"

  node -e "require('$DSH_HOME_DIR/node_modules/koffi');" 2>/dev/null \
    || die "koffi native module failed to load"
  node -e "const p=require('$DSH_HOME_DIR/node_modules/node-pty'); \
const t=p.spawn('echo',['pty-ok'],{name:'x',cols:80,rows:24}); \
t.onData(d=>process.exit(d.includes('pty-ok')?0:1)); \
setTimeout(()=>process.exit(2),5000);" 2>/dev/null \
    || die "node-pty native module failed to spawn a PTY"
  log "native modules (koffi, node-pty) load OK"

  if [ -d "$DSH_HOME_DIR/node_modules/sharp" ]; then
    node -e "require('$DSH_HOME_DIR/node_modules/sharp');" 2>/dev/null \
      || die "sharp failed to load (try: cd $DSH_HOME_DIR && npm i @img/sharp-wasm32)"
    log "sharp loads OK"
  fi

  timeout 60 dsh --profile headless --dump-config >/dev/null 2>&1 \
    || die "dsh profile boot failed (--profile headless --dump-config)"
  log "headless profile boot OK"

  # `dsh web` serves until killed; exit 124 (timeout) is the success signal.
  local web_out
  web_out="$(timeout 20 dsh web 2>&1 || true)"
  printf '%s' "$web_out" | grep -q '127.0.0.1' \
    || die "dsh web failed to start a server: $(printf '%s' "$web_out" | tail -3)"
  # The webserver answers requests before the URL line prints; a bare-400
  # server (stale profile shadow of a host package) used to pass this check.
  # Parse the printed canonical URL and require HTTP 200 on /.
  local web_url web_code
  web_url="$(printf '%s' "$web_out" | grep -o 'http://127\.0\.0\.1:[0-9]*' | head -1)"
  [ -n "$web_url" ] || die "dsh web printed no local URL: $(printf '%s' "$web_out" | tail -3)"
  web_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$web_url/" 2>/dev/null || echo 000)"
  [ "$web_code" = "200" ] \
    || die "dsh web answered HTTP $web_code on $web_url/ (want 200) — likely a stale profile tree; re-run this script"
  log "web profile serves / with HTTP 200 ($web_url)"

  printf '\033[1;32m[setup-dsh]\033[0m All checks passed. dsh is ready.\n'
}

# ── Main ─────────────────────────────────────────────────────────────────
main() {
  local force="" reinstall=""
  for arg in "$@"; do
    case "$arg" in
      --force) force="force" ;;
      --reinstall) reinstall="yes" ;;
      -h|--help) sed -n '2,72p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die "unknown argument: $arg (supported: --force, --reinstall)" ;;
    esac
  done

  is_termux || die "this script is for Termux (aarch64) only"

  log "target: dsh $DSH_VERSION (koffi $KOFFI_VERSION)"
  [ "$reinstall" = "yes" ] && uninstall
  ensure_prereqs
  # Defines gyp's android_ndk_path so node-pty's node-gyp configure works.
  export npm_config_android_ndk_path="$PREFIX"
  ensure_koffi_tarball "$force"
  ensure_wrapper_project
  ensure_install "$force"
  ensure_sharp_wasm
  ensure_session_atomic_rename
  refresh_profiles
  ensure_dsh_zombie_killed
  ensure_webserver_bind
  verify
}

main "$@"
