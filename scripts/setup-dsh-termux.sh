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
#
# Notes:
#   * npm 11 prints "install scripts not yet covered by allowScripts"
#     warnings; the native install scripts still run (verified). If a future
#     npm config blocks them, run: npm install-scripts approve koffi node-pty

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────
# No DSH_VERSION env var -> resolve the latest published version (so plain
# re-runs upgrade); fall back to the last known-good pin if npm is offline.
DSH_VERSION="${DSH_VERSION:-}"
if [ -z "$DSH_VERSION" ]; then
  DSH_VERSION="$(npm view @deepseek-ai/dsh version 2>/dev/null || true)"
  [ -n "$DSH_VERSION" ] || DSH_VERSION="0.1.0-rc.6"
fi
KOFFI_VERSION="${KOFFI_VERSION:-3.1.4}"         # version dsh's range resolves to
DSH_HOME_DIR="${DSH_HOME_DIR:-$HOME/dsh-global}"        # live install (wrapper project)
BUILD_DIR="${BUILD_DIR:-$HOME/.cache/dsh-termux}"        # koffi source + patched tarball
KOFFI_TGZ="$BUILD_DIR/koffi-$KOFFI_VERSION-termux.tgz"  # cached patched tarball
PREFIX="$(dirname "$(dirname "$(command -v node)")")"   # Termux prefix (/data/.../usr)
NODE_BIN="$(command -v node)"
PREFIX_BIN="$PREFIX/bin"

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
  if [[ "$force" != "force" ]] && [ -f "$KOFFI_TGZ" ]; then
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
  }
}
JSON
}

# ── 4. npm install (skips when the pinned version + natives already work) ─
ensure_install() {
  local force="${1:-}" installed_ver
  if [[ "$force" != "force" ]] && [ -f "$DSH_HOME_DIR/node_modules/@deepseek-ai/dsh/package.json" ]; then
    installed_ver="$(python3 -c "import json;print(json.load(open('$DSH_HOME_DIR/node_modules/@deepseek-ai/dsh/package.json'))['version'])" 2>/dev/null || true)"
    if [ "$installed_ver" = "$DSH_VERSION" ] \
       && node -e "require('$DSH_HOME_DIR/node_modules/koffi'); require('$DSH_HOME_DIR/node_modules/node-pty');" 2>/dev/null; then
      log "dsh $installed_ver already installed and native modules load — skipping npm install."
      return 0
    fi
    warn "found dsh '$installed_ver' but want '$DSH_VERSION' (or natives broken) — reinstalling."
  fi
  log "npm install (first run takes several minutes)..."
  ( cd "$DSH_HOME_DIR" && npm i >/dev/null ) || die "npm install failed — see $HOME/.npm/_logs"
  log "npm install done."
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
  ( cd "$DSH_HOME_DIR" && npm i @img/sharp-wasm32 >/dev/null 2>&1 ) \
    || die "npm install @img/sharp-wasm32 failed"
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

# ── 8. Verify ────────────────────────────────────────────────────────────
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
  log "web profile boot OK (server up)"

  printf '\033[1;32m[setup-dsh]\033[0m All checks passed. dsh is ready.\n'
}

# ── Main ─────────────────────────────────────────────────────────────────
main() {
  local force=""
  for arg in "$@"; do
    case "$arg" in
      --force) force="force" ;;
      -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die "unknown argument: $arg (only --force supported)" ;;
    esac
  done

  is_termux || die "this script is for Termux (aarch64) only"

  log "target: dsh $DSH_VERSION (koffi $KOFFI_VERSION)"
  ensure_prereqs
  # Defines gyp's android_ndk_path so node-pty's node-gyp configure works.
  export npm_config_android_ndk_path="$PREFIX"
  ensure_koffi_tarball "$force"
  ensure_wrapper_project
  ensure_install "$force"
  ensure_sharp_wasm
  ensure_session_atomic_rename
  ensure_dsh_bin
  verify
}

main "$@"
