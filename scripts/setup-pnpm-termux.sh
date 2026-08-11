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
#
# IDEMPOTENT: safe to run repeatedly. Skips download if the pinned
# version is already installed; rewrites wrapper only when it changed.
#
# Usage:
#   bash setup-pnpm-termux.sh                # install/verify pnpm 12
#   PNPM_VERSION=12.0.0-rc.3 bash setup-pnpm-termux.sh   # pin a version
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

# ── Helpers ──────────────────────────────────────────────────────────────
log()  { printf '\033[1;34m[setup-pnpm]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup-pnpm]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[setup-pnpm]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. glibc-runner (grun) — required to exec the glibc pnpm binary ─────
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

# ── 2. Download pnpm 12 standalone (glibc variant) ──────────────────────
detect_arch() {
  case "$(uname -m)" in
    aarch64|arm64) echo "arm64" ;;
    x86_64|amd64)  echo "x64" ;;
    *) die "unsupported arch: $(uname -m)" ;;
  esac
}

ensure_pnpm_binary() {
  local arch url tmp installed
  arch="$(detect_arch)"

  # Already installed at the pinned version? Done (the idempotent fast path).
  if [ -x "$PNPM_BIN" ]; then
    installed="$(grun "$PNPM_BIN" --version 2>/dev/null || true)"
    if [ -n "$installed" ] && [ "$installed" = "$PNPM_VERSION" ]; then
      log "pnpm $installed already installed at $PNPM_BIN — skipping download."
      return 0
    fi
    warn "found pnpm '$installed' but want '$PNPM_VERSION' — replacing."
  fi

  url="https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-${arch}.tar.gz"
  log "Downloading pnpm ${PNPM_VERSION} ($arch)..."
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$url" -o "$tmp/pnpm.tar.gz" || die "download failed: $url"
  tar -xzf "$tmp/pnpm.tar.gz" -C "$tmp" || die "extract failed"
  [ -f "$tmp/pnpm" ] || die "tarball has no pnpm binary"

  mkdir -p "$PNPM_HOME"
  install -m 0755 "$tmp/pnpm" "$PNPM_BIN"
  # dist/ ships alongside the binary; replace it atomically-ish.
  rm -rf "$PNPM_HOME/dist.new"
  cp -r "$tmp/dist" "$PNPM_HOME/dist.new"
  rm -rf "$PNPM_HOME/dist"
  mv "$PNPM_HOME/dist.new" "$PNPM_HOME/dist"
  log "Installed pnpm binary to $PNPM_BIN"
}

# ── 3. Wrapper: `pnpm` on PATH that execs grun <binary> ─────────────────
ensure_wrapper() {
  mkdir -p "$WRAPPER_DIR"
  local content
  content="#!/data/data/com.termux/files/usr/bin/bash
# pnpm standalone (glibc ELF) launched via glibc-runner.
exec grun '$PNPM_BIN' \"\$@\"
"
  # Only rewrite when content changed (keeps it truly idempotent).
  # Note: both sides must go through $(...) so trailing-newline handling
  # matches (command substitution strips the final newline).
  if [ -f "$WRAPPER" ] && [ "$(cat "$WRAPPER")" = "$(printf '%s' "$content")" ]; then
    log "wrapper unchanged at $WRAPPER"
    return 0
  fi
  printf '%s' "$content" > "$WRAPPER"
  chmod +x "$WRAPPER"
  log "wrote wrapper $WRAPPER"
}

# ── 4. Global config: copy (Termux forbids hardlinks) ────────────────────
ensure_global_config() {
  # pnpm 12's Rust port reads this from the global config.yaml;
  # `pnpm config set` is idempotent (same value → no-op).
  grun "$PNPM_BIN" config set packageImportMethod copy >/dev/null 2>&1 \
    || die "could not set packageImportMethod"
  log "global packageImportMethod=copy (Termux hardlink workaround)"
}

# ── 5. PATH check ────────────────────────────────────────────────────────
ensure_path() {
  case ":$PATH:" in
    *":$WRAPPER_DIR:"*) log "PATH already includes $WRAPPER_DIR" ;;
    *)
      warn "$WRAPPER_DIR not on PATH. Add to ~/.bashrc:"
      warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac
}

# ── 6. Verify ────────────────────────────────────────────────────────────
verify() {
  local v
  v="$(grun "$PNPM_BIN" --version 2>/dev/null)" || die "pnpm does not run"
  log "pnpm $v OK (via glibc-runner)"
  command -v pnpm >/dev/null 2>&1 && log "shell command: $(command -v pnpm)" \
    || warn "wrapper not on PATH yet"
}

# ── Main ─────────────────────────────────────────────────────────────────
main() {
  log "Termux pnpm setup (idempotent)"
  ensure_glibc_runner
  ensure_pnpm_binary
  ensure_wrapper
  ensure_global_config
  ensure_path
  verify
  log "Done."
}

main "$@"
