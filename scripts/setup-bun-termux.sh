#!/data/data/com.termux/files/usr/bin/bash
# setup-bun-termux.sh — idempotent bun installer for Termux (aarch64).
#
# WHY THIS EXISTS (from real Termux debugging):
#   * The OFFICIAL installer (`curl -fsSL https://bun.sh/install | bash`)
#     is used as recommended and installs bun to ~/.bun/bin/bun — but the
#     downloaded binary is a GLIBC-linked ELF whose PT_INTERP
#     (/lib/ld-linux-aarch64.so.1) does not exist on Android. The kernel
#     refuses to exec it:
#       "cannot execute: required file not found"
#   * WORKING: run the binary through glibc-runner (grun). A small `bun`
#     wrapper on PATH does that, exactly like the official glibc-runner
#     package runs other glibc binaries on Termux.
#   * Termux /data SELinux blocks link(2) for apps (verified: `ln` fails with
#     "Permission denied"), so bun's default "hardlink" install backend fails
#     EVERY install:
#       "EACCES: Permission denied while installing <pkg>"
#   * bun 1.3.x reads ~/.bunfig.toml but IGNORES `install.backend` for global
#     (`-g`) installs (verified: registry key from the same file applied, the
#     backend key did not). The only thing that works for `-g` is the
#     --backend=copyfile CLI flag, so the wrapper injects it for `bun add` /
#     `bun install`.
#   * PATH order matters: ~/.local/bin (wrapper) must come BEFORE
#     $BUN_INSTALL/bin (raw, unexecutable binary), or `bun` resolves to the
#     broken binary. The script owns a managed block at the END of ~/.bashrc
#     to guarantee the order, and strips stale duplicate exports.
#
# IDEMPOTENT: safe to run repeatedly. Skips the download when the binary is
# already present and runs; rewrites wrappers/config only when changed.
#
# Usage:
#   bash setup-bun-termux.sh                          # install/verify latest bun
#   BUN_VERSION=bun-v1.2.30 bash setup-bun-termux.sh  # pin a version/tag
#   bash setup-bun-termux.sh --force                  # re-download the binary
#
# On non-Termux Linux/macOS this just runs the official installer unchanged
# (no wrapper, no copyfile — hardlinks work there).

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"          # bun's recommended layout
BUN_BIN="$BUN_INSTALL/bin/bun"
BUN_VERSION="${BUN_VERSION:-}"                    # e.g. bun-v1.2.30; empty = latest
WRAPPER_DIR="${WRAPPER_DIR:-$HOME/.local/bin}"
WRAPPER="$WRAPPER_DIR/bun"
PI_BIN_DIR="${PI_BIN_DIR:-$HOME/.pi/agent/bin}"   # pi agent bin (only if present)
BUNFIG="$HOME/.bunfig.toml"
BASHRC="$HOME/.bashrc"

# ── Helpers ──────────────────────────────────────────────────────────────
log()  { printf '\033[1;34m[setup-bun]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup-bun]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[setup-bun]\033[0m %s\n' "$*" >&2; exit 1; }

is_termux() { [[ -n "${PREFIX:-}" ]] && [[ -d "$PREFIX" ]]; }

# The wrapper logic, shared by ~/.local/bin/bun and the pi-agent wrapper.
wrapper_body() {
  local bin_path="$1"
  printf '%s\n' \
    '#!/data/data/com.termux/files/usr/bin/bash' \
    '# bun launcher (glibc ELF) via glibc-runner; --backend=copyfile injected' \
    '# for add/install because Termux SELinux blocks hardlinks (EACCES).' \
    'args=("$@")' \
    'case "${1:-}" in' \
    '    add|install)' \
    '        have_backend=0' \
    '        for a in "$@"; do' \
    '            case "$a" in' \
    '                --backend=*) have_backend=1 ;;' \
    '            esac' \
    '        done' \
    '        if [ "$have_backend" = "0" ]; then' \
    '            args=(--backend=copyfile "$@")' \
    '        fi' \
    '        ;;' \
    'esac' \
    "exec grun '$bin_path' \"\${args[@]}\""
}

# ── 1. Pre-reqs: curl + unzip (the official installer needs unzip) ──────
ensure_prereqs() {
  local missing=()
  command -v curl  >/dev/null 2>&1 || missing+=(curl)
  command -v unzip >/dev/null 2>&1 || missing+=(unzip)
  if [[ ${#missing[@]} -gt 0 ]]; then
    log "installing missing prereqs: ${missing[*]}"
    pkg install -y "${missing[@]}"
  fi
  command -v curl  >/dev/null 2>&1 || die "curl still missing"
  command -v unzip >/dev/null 2>&1 || die "unzip still missing"
}

# ── 2. glibc-runner (grun) — required to exec the glibc bun binary ──────
ensure_glibc_runner() {
  if command -v grun >/dev/null 2>&1; then
    log "glibc-runner present: $(command -v grun)"
    return 0
  fi
  log "glibc-runner missing — installing (needs termux-glibc repo)..."
  pkg install -y glibc-repo 2>/dev/null || true
  pkg update
  pkg install -y glibc-runner
  command -v grun >/dev/null 2>&1 || die "grun still missing after install"
  log "glibc-runner installed."
}

# ── 3. Official installer → $BUN_INSTALL/bin/bun (bun's recommendation) ─
run_official_installer() {
  if [[ -n "$BUN_VERSION" ]]; then
    local tag="$BUN_VERSION"
    [[ "$tag" = bun-v* ]] || tag="bun-v$tag"
    log "running official installer (tag $tag)..."
    if ! curl -fsSL https://bun.sh/install | bash -s "$tag"; then
      die "official installer failed (tag $tag)"
    fi
  else
    log "running official installer (curl -fsSL https://bun.sh/install | bash)..."
    if ! curl -fsSL https://bun.sh/install | bash; then
      die "official installer failed"
    fi
  fi
}

install_bun_via_official() {
  # Fast path: binary present AND runs through grun → nothing to do.
  if [[ "${1:-}" != "force" ]] && [[ -x "$BUN_BIN" ]]; then
    local v="$(grun "$BUN_BIN" --version 2>/dev/null || true)"
    if [[ -n "$v" ]]; then
      log "bun $v already installed at $BUN_BIN — skipping download."
      return 0
    fi
    warn "found $BUN_BIN but it does not run — replacing."
  fi
  [[ "${1:-}" = "force" ]] && log "--force: re-downloading bun binary"

  mkdir -p "$BUN_INSTALL/bin"
  export BUN_INSTALL   # the piped `bash` must see it (not just curl)
  run_official_installer
  [[ -x "$BUN_BIN" ]] || die "official installer finished but $BUN_BIN is missing"
  log "bun binary at $BUN_BIN (bun's recommended location)"
}

# ── 4. Wrapper: `bun` on PATH that execs grun <binary> + copyfile backend ─
ensure_wrapper() {
  mkdir -p "$WRAPPER_DIR"
  local content
  content="$(wrapper_body "$BUN_BIN")"
  if [ -f "$WRAPPER" ] && [ "$(cat "$WRAPPER")" = "$content" ]; then
    log "wrapper unchanged at $WRAPPER"
    return 0
  fi
  printf '%s\n' "$content" > "$WRAPPER"
  chmod +x "$WRAPPER"
  log "wrote wrapper $WRAPPER"
}

# ── 5. Pi agent wrapper (pi sessions prepend ~/.pi/agent/bin) ────────────
ensure_pi_wrapper() {
  [[ -d "$PI_BIN_DIR" ]] || {
    log "no pi agent bin dir ($PI_BIN_DIR) — skipping pi wrapper"
    return 0
  }
  local target="$PI_BIN_DIR/bun"
  local content
  content="$(wrapper_body "$BUN_BIN")"
  if [ -f "$target" ] && [ "$(cat "$target")" = "$content" ]; then
    log "pi wrapper unchanged at $target"
    return 0
  fi
  printf '%s\n' "$content" > "$target"
  chmod +x "$target"
  log "wrote pi wrapper $target"
}

# ── 6. Global config: copyfile (Termux forbids hardlinks) ────────────────
ensure_bunfig() {
  local content
  content="# bun on Termux cannot create hardlinks: Android SELinux blocks link(2)
# for apps, so bun's default \"hardlink\" install backend fails every install
# with EACCES. Use \"copyfile\" instead.
# Note: bun 1.3.x ignores this key for -g (global) installs; the bun wrapper
# injects --backend=copyfile for those.
[install]
backend = \"copyfile\"
"
  if [ -f "$BUNFIG" ] && [ "$(cat "$BUNFIG")" = "$(printf '%s' "$content")" ]; then
    log "bunfig unchanged at $BUNFIG"
    return 0
  fi
  printf '%s' "$content" > "$BUNFIG"
  log "wrote $BUNFIG"
}

# ── 7. ~/.bashrc: managed PATH block (wrapper before raw binary) ─────────
ensure_bashrc() {
  local marker_top="# >>> bun-termux (managed by setup-bun-termux.sh) >>>"
  local marker_bot="# <<< bun-termux (managed by setup-bun-termux.sh) <<<"
  local block
  block="$marker_top
# The raw \$BUN_INSTALL/bin/bun is a glibc ELF that cannot exec on Android
# (PT_INTERP /lib/ld-linux-aarch64.so.1 missing). The working launcher is the
# grun wrapper in ~/.local/bin, so ~/.local/bin must precede \$BUN_INSTALL/bin.
export BUN_INSTALL=\"$BUN_INSTALL\"
export PATH=\"\$BUN_INSTALL/bin:\$PATH\"
export PATH=\"\$HOME/.local/bin:\$PATH\"
$marker_bot"

  # Drop any previous managed block, then strip stale duplicate exports so
  # this block stays the single source of truth for those lines (this also
  # removes the block the official installer may have appended on first run).
  if [[ -f "$BASHRC" ]]; then
    sed -i '/^# >>> bun-termux (managed by setup-bun-termux.sh) >>>$/,/^# <<< bun-termux (managed by setup-bun-termux.sh) <<<$/d' "$BASHRC"
    sed -i '\#^export BUN_INSTALL=#d
            \#^export PATH="$BUN_INSTALL/bin:$PATH"$#d
            \#^export PATH="$HOME/.local/bin:$PATH"$#d' "$BASHRC"
  fi
  printf '\n%s\n' "$block" >> "$BASHRC"
  log "managed PATH block appended to $BASHRC"
}

# ── 8. Verify ────────────────────────────────────────────────────────────
verify() {
  local v scratch
  v="$(grun "$BUN_BIN" --version 2>/dev/null)" || die "bun does not run via grun"
  log "bun $v OK (via glibc-runner)"
  command -v bun >/dev/null 2>&1 && log "shell command: $(command -v bun)" \
    || warn "wrapper not on PATH yet — open a new shell"

  # End-to-end check: a scratch global install must actually land files.
  # With the injected copyfile backend it does; with the hardlink backend
  # (the default) Android SELinux would fail it with EACCES.
  scratch="$(mktemp -d "$HOME/.bun-verify.XXXXXX")"
  if BUN_INSTALL="$scratch" "$WRAPPER" add -g is-number >/dev/null 2>&1 \
     && [[ -f "$scratch/install/global/node_modules/is-number/package.json" ]]; then
    log "scratch global install OK (copyfile backend working)"
  else
    warn "scratch global install failed — check network; installs may still hit EACCES"
  fi
  rm -rf "$scratch"
}

# ── Main ─────────────────────────────────────────────────────────────────
main() {
  local force=""
  [[ "${1:-}" = "--force" ]] && force="force"

  if ! is_termux; then
    log "not Termux — running the official bun installer unchanged"
    export BUN_INSTALL
    run_official_installer
    log "Done."
    exit 0
  fi

  log "Termux bun setup (idempotent)"
  ensure_prereqs
  ensure_glibc_runner
  install_bun_via_official "$force"
  ensure_wrapper
  ensure_pi_wrapper
  ensure_bunfig
  ensure_bashrc
  verify
  log "Done."
}

main "$@"
