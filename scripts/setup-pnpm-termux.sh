#!/data/data/com.termux/files/usr/bin/bash
# setup-pnpm-termux.sh — idempotent pnpm installer for Termux (aarch64).
#
# WHY THIS EXISTS (from real Termux debugging):
#   * `curl -fsSL https://get.pnpm.io/install.sh | sh -` fails on Termux:
#       - `getconf` is missing  → arch/libc detection breaks
#       - the downloaded binary is a glibc-linked ELF; Termux's bionic
#         loader cannot exec it ("pnpm: not found" / "required file not found")
#   * `npm install -g pnpm` is deprecated (pnpm docs).
#   * corepack is gone from Node >= 25, so no corepack path either.
#   * WORKING: run pnpm's standalone binary through glibc-runner (grun).
#     pnpm 12 (Rust port) resolves its dist/ correctly under grun;
#     pnpm 10/11 (Node SEA) do NOT (they resolve dist/ from the loader
#     path). So we install pnpm 12.
#   * Termux /data forbids hardlinks (EACCES on link()) → pnpm must copy
#     packages from the store: packageImportMethod=copy (global config).
#   * LD_PRELOAD trap (verified): interactive Termux shells preload the
#     bionic libtermux-exec.so (DT_NEEDED libc.so — bionic name); the glibc
#     loader resolves that to the GNU-ld linker-script libc.so and dies with
#     "invalid ELF header" (breaks grun's own glibc bash too). The wrapper
#     must `unset LD_PRELOAD` first — same fix as setup-opencode-termux.sh.
#
# IDEMPOTENT: safe to run repeatedly. Skips download if the pinned
# version is already installed; rewrites wrapper only when it changed.
#
# Usage:
#   bash setup-pnpm-termux.sh                # install/verify pnpm 12
#   PNPM_VERSION=12.0.0-rc.3 bash setup-pnpm-termux.sh   # pin a version
#   bash setup-pnpm-termux.sh --force        # re-download the binary
#
# Project-level notes (NOT handled here — per-project):
#   * Per pnpm docs (https://pnpm.io/settings) all non-auth settings live in
#     pnpm-workspace.yaml with camelCase keys, NOT in .npmrc (only auth /
#     registry are read from .npmrc). Use `shamefullyHoist: true`,
#     `packageImportMethod: copy`, etc. there.
#   * pnpm 12 misdetects android as linux for optional native deps; add
#     `supportedArchitectures: {os:[android,linux], cpu:[arm64]}` to the
#     project pnpm-workspace.yaml so android bindings install.
#   * A dashboard/sub-app with its own lockfile needs its own
#     pnpm-workspace.yaml so pnpm 12 doesn't absorb it into the root
#     workspace.

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────
PNPM_VERSION="${PNPM_VERSION:-12.0.0-rc.3}"   # pinned default (verified on Termux)
PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"   # binary + dist live here
PNPM_BIN="$PNPM_HOME/pnpm"
WRAPPER_DIR="${WRAPPER_DIR:-$HOME/.local/bin}"
WRAPPER="$WRAPPER_DIR/pnpm"
PI_BIN_DIR="${PI_BIN_DIR:-$HOME/.pi/agent/bin}"     # pi agent bin (only if present)
BASHRC="$HOME/.bashrc"

# ── Helpers ──────────────────────────────────────────────────────────────
log()  { printf '\033[1;34m[setup-pnpm]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup-pnpm]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[setup-pnpm]\033[0m %s\n' "$*" >&2; exit 1; }

# The wrapper logic, shared by ~/.local/bin/pnpm and the pi-agent wrapper.
wrapper_body() {
  local bin_path="$1"
  printf '%s\n' \
    '#!/data/data/com.termux/files/usr/bin/bash' \
    '# pnpm standalone (glibc ELF) launched via glibc-runner.' \
    '# unset LD_PRELOAD: the bionic libtermux-exec.so preload (DT_NEEDED' \
    '# libc.so) makes the glibc loader die with "invalid ELF header".' \
    'unset LD_PRELOAD' \
    "exec grun '$bin_path' \"\$@\""
}

# ── 1. Pre-reqs: curl + tar ──────────────────────────────────────────────
ensure_prereqs() {
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v tar  >/dev/null 2>&1 || missing+=(tar)
  if [[ ${#missing[@]} -gt 0 ]]; then
    log "installing missing prereqs: ${missing[*]}"
    pkg install -y "${missing[@]}"
  fi
  command -v curl >/dev/null 2>&1 || die "curl still missing"
  command -v tar  >/dev/null 2>&1 || die "tar still missing"
}

# ── 2. glibc-runner (grun) — required to exec the glibc pnpm binary ─────
ensure_glibc_runner() {
  if command -v grun >/dev/null 2>&1; then
    log "glibc-runner present: $(command -v grun)"
    return 0
  fi
  log "glibc-runner missing — installing (needs termux-glibc repo)..."
  # glibc-repo enables the termux-glibc apt source (idempotent).
  pkg install -y glibc-repo 2>/dev/null || true
  pkg update
  pkg install -y glibc-runner
  command -v grun >/dev/null 2>&1 || die "grun still missing after install"
  log "glibc-runner installed."
}

# ── 3. Download pnpm 12 standalone (glibc variant) ──────────────────────
detect_arch() {
  case "$(uname -m)" in
    aarch64|arm64) echo "arm64" ;;
    x86_64|amd64)  echo "x64" ;;
    *) die "unsupported arch: $(uname -m)" ;;
  esac
}

ensure_pnpm_binary() {
  local force="${1:-}" arch url tmp installed
  arch="$(detect_arch)"

  # Already installed at the pinned version? Done (the idempotent fast path).
  if [[ "$force" != "force" ]] && [ -x "$PNPM_BIN" ]; then
    installed="$(grun "$PNPM_BIN" --version 2>/dev/null || true)"
    if [ -n "$installed" ] && [ "$installed" = "$PNPM_VERSION" ]; then
      log "pnpm $installed already installed at $PNPM_BIN — skipping download."
      return 0
    fi
    warn "found pnpm '$installed' but want '$PNPM_VERSION' — replacing."
  fi

  [[ "$force" = "force" ]] && log "--force: re-downloading pnpm binary"
  url="https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-${arch}.tar.gz"
  log "Downloading pnpm ${PNPM_VERSION} ($arch)..."
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$url" -o "$tmp/pnpm.tar.gz" || die "download failed: $url"
  tar -xzf "$tmp/pnpm.tar.gz" -C "$tmp" || die "extract failed"
  [ -f "$tmp/pnpm" ] || die "tarball has no pnpm binary"

  mkdir -p "$PNPM_HOME"
  install -m 0755 "$tmp/pnpm" "$PNPM_BIN"
  # dist/ ships alongside the binary; swap it without a missing-dist window.
  rm -rf "$PNPM_HOME/dist.new" "$PNPM_HOME/dist.old"
  cp -r "$tmp/dist" "$PNPM_HOME/dist.new"
  if [ -d "$PNPM_HOME/dist" ]; then mv "$PNPM_HOME/dist" "$PNPM_HOME/dist.old"; fi
  mv "$PNPM_HOME/dist.new" "$PNPM_HOME/dist"
  rm -rf "$PNPM_HOME/dist.old"
  log "Installed pnpm binary to $PNPM_BIN"
}

# ── 4. Wrapper: `pnpm` on PATH that execs grun <binary> (LD_PRELOAD-safe) ─
ensure_wrapper() {
  mkdir -p "$WRAPPER_DIR"
  local content
  content="$(wrapper_body "$PNPM_BIN")"
  # Note: both sides go through $(...) so trailing-newline handling matches
  # (command substitution strips the final newline).
  if [ -f "$WRAPPER" ] && [ "$(cat "$WRAPPER")" = "$(printf '%s' "$content")" ]; then
    log "wrapper unchanged at $WRAPPER"
    return 0
  fi
  printf '%s' "$content" > "$WRAPPER"
  chmod +x "$WRAPPER"
  log "wrote wrapper $WRAPPER"
}

# ── 5. Pi agent wrapper (pi sessions prepend ~/.pi/agent/bin) ────────────
ensure_pi_wrapper() {
  [[ -d "$PI_BIN_DIR" ]] || {
    log "no pi agent bin dir ($PI_BIN_DIR) — skipping pi wrapper"
    return 0
  }
  local target="$PI_BIN_DIR/pnpm"
  local content
  content="$(wrapper_body "$PNPM_BIN")"
  if [ -f "$target" ] && [ "$(cat "$target")" = "$(printf '%s' "$content")" ]; then
    log "pi wrapper unchanged at $target"
    return 0
  fi
  printf '%s' "$content" > "$target"
  chmod +x "$target"
  log "wrote pi wrapper $target"
}

# ── 6. Global config: copy (Termux forbids hardlinks) ────────────────────
ensure_global_config() {
  # pnpm 12's Rust port reads this from the global config.yaml;
  # `pnpm config set` is idempotent (same value → no-op).
  "$WRAPPER" config set packageImportMethod copy >/dev/null 2>&1 \
    || die "could not set packageImportMethod"
  log "global packageImportMethod=copy (Termux hardlink workaround)"
}

# ── 7. PATH: ensure ~/.local/bin (the wrapper dir) is on PATH ────────────
ensure_path() {
  if [[ ":$PATH:" == *":$WRAPPER_DIR:"* ]]; then
    log "PATH already includes $WRAPPER_DIR"
    return 0
  fi
  # Append the export (exact line form shared with the bun/opencode managed
  # blocks; those scripts strip standalone copies and re-own the line, so
  # repeated runs converge). Skip if some config already has it.
  if [[ -f "$BASHRC" ]] && grep -Fxq 'export PATH="$HOME/.local/bin:$PATH"' "$BASHRC"; then
    log "PATH line already in $BASHRC — open a new shell"
    return 0
  fi
  printf '\n# pnpm wrapper dir on PATH\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$BASHRC"
  warn "appended export to $BASHRC — open a new shell (or source it)"
}

# ── 8. Verify ────────────────────────────────────────────────────────────
verify() {
  local v
  v="$(grun "$PNPM_BIN" --version 2>/dev/null)" || die "pnpm does not run"
  log "pnpm $v OK (via glibc-runner)"
  "$WRAPPER" --version >/dev/null 2>&1 \
    && log "wrapper OK: $WRAPPER" \
    || die "wrapper $WRAPPER failed to run"
  # The user's interactive shell preloads the bionic libtermux-exec.so; the
  # wrapper must survive that env (unset LD_PRELOAD).
  if [[ -f "${PREFIX:-/nonexistent}/lib/libtermux-exec.so" ]]; then
    LD_PRELOAD="$PREFIX/lib/libtermux-exec.so" "$WRAPPER" --version >/dev/null 2>&1 \
      && log "wrapper OK under bionic termux-exec LD_PRELOAD" \
      || die "wrapper fails under bionic termux-exec LD_PRELOAD — unset LD_PRELOAD missing?"
  fi
  command -v pnpm >/dev/null 2>&1 && log "shell command: $(command -v pnpm)" \
    || warn "wrapper not on PATH yet"
}

# ── Main ─────────────────────────────────────────────────────────────────
main() {
  local force=""
  [[ "${1:-}" = "--force" ]] && force="force"

  log "Termux pnpm setup (idempotent)"
  ensure_prereqs
  ensure_glibc_runner
  ensure_pnpm_binary "$force"
  ensure_wrapper
  ensure_pi_wrapper
  ensure_global_config
  ensure_path
  verify
  log "Done."
}

main "$@"
