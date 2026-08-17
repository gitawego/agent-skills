#!/data/data/com.termux/files/usr/bin/bash
# setup-opencode-termux.sh — idempotent opencode v2 installer for Termux (aarch64).
#
# WHY THIS EXISTS (from real Termux debugging):
#   * The OFFICIAL installer (`curl -fsSL
#     https://raw.githubusercontent.com/anomalyco/opencode/v2/install | bash`)
#     installs the binary to ~/.opencode/bin/opencode2 — but it is a GLIBC
#     ELF whose PT_INTERP (/lib/ld-linux-aarch64.so.1) does not exist on
#     Android, so the kernel refuses to exec it.
#   * Wrapping with glibc-runner (grun → `ld.so opencode2`) runs the CLIENT,
#     but breaks the SERVER: the client spawns its background server as
#     `[process.execPath, "serve", "--service"]`, and under grun execPath is
#     the loader, so the spawn becomes `ld.so serve` → "serve: error while
#     loading shared libraries: serve: cannot open shared object file".
#   * `glibc-runner --configure` (patchelf) CORRUPTS this binary: Bun
#     single-file executables locate their embedded payload via the ELF
#     layout, and patchelf's segment rewrite segfaults it (exit 139) even
#     under grun. Verified.
#   * WORKING: patch ONLY the PT_INTERP string IN PLACE (zero layout
#     changes) to a short absolute path that symlinks to the glibc loader:
#     "/data/data/com.termux/ld" (25 chars, fits the original 27-byte slot)
#     → $PREFIX/glibc/lib/ld-linux-aarch64.so.1. The binary then execs
#     natively, process.execPath is the real binary, and the server spawn
#     works. The ~/.local/bin/opencode2 wrapper must exec the binary
#     DIRECTLY (NOT via grun — the loader would return as execPath again).
#
# IDEMPOTENT: safe to run repeatedly. Skips the download when the binary is
# already present and runnable; re-patches the interp whenever the binary is
# replaced; rewrites wrappers/config only when changed; the ~/.bashrc block
# is a single marker-delimited block (stripped and rewritten, never
# accumulated).
#
# Usage:
#   bash setup-opencode-termux.sh                           # install/verify latest v2
#   OPENCODE_VERSION=0.0.0-next-17403 bash setup-opencode-termux.sh  # pin a version
#   bash setup-opencode-termux.sh --force                   # re-download the binary
#   bash setup-opencode-termux.sh --upgrade                 # upgrade + auto-repatch
#
# The `opencode-upgrade` alias in ~/.bashrc (managed block below) runs
# `--upgrade`: it re-downloads the latest binary and re-applies the
# PT_INTERP patch, because `opencode2 upgrade` / the installer ship a
# pristine, unpatched binary.
#
# On non-Termux Linux/macOS this just runs the official installer unchanged
# (no patching — glibc binaries exec natively there).

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────
INSTALL_DIR="${INSTALL_DIR:-$HOME/.opencode/bin}"   # official installer's layout
BIN="$INSTALL_DIR/opencode2"
OPENCODE_VERSION="${OPENCODE_VERSION:-}"            # e.g. 0.0.0-next-17403; empty = latest
WRAPPER_DIR="${WRAPPER_DIR:-$HOME/.local/bin}"
WRAPPER="$WRAPPER_DIR/opencode2"
PI_BIN_DIR="${PI_BIN_DIR:-$HOME/.pi/agent/bin}"     # pi agent bin (only if present)
BASHRC="$HOME/.bashrc"
INSTALLER_URL="https://raw.githubusercontent.com/anomalyco/opencode/v2/install"
SCRIPT_PATH="$(realpath "${BASH_SOURCE[0]}")"

# Short interp path → glibc loader symlink. MUST fit in the original
# 27-byte PT_INTERP slot (26 bytes incl. NUL for this path).
SHORT_LD_DIR="$(dirname "$(dirname "${PREFIX:-/data/data/com.termux/files/usr}")")"
SHORT_LD="$SHORT_LD_DIR/ld"
GLIBC_LD="${PREFIX:-/data/data/com.termux/files/usr}/glibc/lib/ld-linux-aarch64.so.1"

# ── Helpers ──────────────────────────────────────────────────────────────
log()  { printf '\033[1;34m[setup-opencode2]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup-opencode2]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[setup-opencode2]\033[0m %s\n' "$*" >&2; exit 1; }

is_termux() {
  if [[ -n "${PREFIX:-}" ]] && [[ -d "$PREFIX" ]]; then return 0; fi
  # PREFIX can be absent in stripped environments (env -i, cron, ...) that
  # still run on a Termux device.
  [[ -d /data/data/com.termux ]]
}

# The wrapper logic, shared by ~/.local/bin/opencode2 and the pi-agent wrapper.
wrapper_body() {
  local bin_path="$1"
  printf '%s\n' \
    '#!/data/data/com.termux/files/usr/bin/bash' \
    '# opencode2 launcher: the binary is PT_INTERP-patched (glibc loader via' \
    '# /data/data/com.termux/ld symlink) so it execs natively on Android. Do' \
    '# NOT use grun here: under `ld.so opencode2` process.execPath is the' \
    '# loader and the server spawn (`execPath serve --service`) fails.' \
    '# unset LD_PRELOAD: Termux shells preload the bionic libtermux-exec.so,' \
    '# whose DT_NEEDED is libc.so (bionic name); the glibc loader resolves' \
    '# that to the ld linker-script libc.so -> "invalid ELF header".' \
    'unset LD_PRELOAD' \
    "exec '$bin_path' \"\$@\""
}

# ── 1. Pre-reqs: curl + tar (official installer) + python3 (interp patch) ─
ensure_prereqs() {
  local missing=()
  command -v curl    >/dev/null 2>&1 || missing+=(curl)
  command -v tar     >/dev/null 2>&1 || missing+=(tar)
  command -v python3 >/dev/null 2>&1 || missing+=(python)
  if [[ ${#missing[@]} -gt 0 ]]; then
    log "installing missing prereqs: ${missing[*]}"
    pkg install -y "${missing[@]}"
  fi
  command -v curl    >/dev/null 2>&1 || die "curl still missing"
  command -v tar     >/dev/null 2>&1 || die "tar still missing"
  command -v python3 >/dev/null 2>&1 || die "python3 still missing"
}

# ── 2. glibc — the loader our patched interp points at ───────────────────
ensure_glibc() {
  if [[ -f "$GLIBC_LD" ]]; then
    log "glibc loader present: $GLIBC_LD"
    return 0
  fi
  log "glibc missing — installing (needs termux-glibc repo)..."
  pkg install -y glibc-repo 2>/dev/null || true
  pkg update
  pkg install -y glibc
  [[ -f "$GLIBC_LD" ]] || die "glibc loader still missing after install"
  log "glibc installed."
}

# ── 3. Official installer → $INSTALL_DIR/opencode2 (upstream's layout) ────
# `modify-path` (non-Termux) lets the installer edit shell configs; on Termux
# we pass --no-modify-path and own the PATH handling ourselves.
run_official_installer() {
  local args=()
  [[ "${1:-}" != "modify-path" ]] && args+=(--no-modify-path)
  [[ -n "$OPENCODE_VERSION" ]] && args+=(--version "$OPENCODE_VERSION")
  log "running official installer (v2)..."
  curl -fsSL "$INSTALLER_URL" | bash -s -- "${args[@]}"
}

install_via_official() {
  local force="${1:-}"

  # Fast path (idempotency): binary present AND executable (natively or via
  # the loader) → nothing to download; configure_binary re-patches it.
  if [[ "$force" != "force" ]] && [[ -x "$BIN" ]]; then
    local v
    v="$("$BIN" --version 2>/dev/null || grun "$BIN" --version 2>/dev/null || true)"
    if [[ -n "$v" ]]; then
      log "opencode2 already installed at $BIN ($v) — skipping download."
      return 0
    fi
    warn "found $BIN but it does not run — replacing."
  fi

  [[ "$force" = "force" ]] && log "--force/--upgrade: re-downloading opencode2 binary"

  mkdir -p "$INSTALL_DIR"
  # Do NOT remove the old binary here: the installer atomically replaces it
  # at the end (mv), so `opencode2` stays runnable during the whole upgrade.
  # The official installer early-exits when `command -v opencode2` finds a
  # runnable binary whose version matches (defeating --force). Run it with
  # PATH stripped of our wrapper dir AND the raw binary dir so that check
  # cannot short-circuit. No wrapper file moves → an interrupted upgrade can
  # never leave `opencode2` missing from ~/.local/bin.
  local filtered
  filtered="$(IFS=: read -ra dirs <<< "$PATH"; out=(); for d in "${dirs[@]}"; do
    [[ -n "$d" && "$d" != "$WRAPPER_DIR" && "$d" != "$INSTALL_DIR" ]] && out+=("$d")
  done; IFS=:; printf '%s' "${out[*]}")"
  if ! PATH="$filtered" run_official_installer; then
    die "official installer failed"
  fi

  [[ -x "$BIN" ]] || die "official installer finished but $BIN is missing"
  log "opencode2 binary at $BIN"
}

# ── 4. In-place PT_INTERP patch (the actual Termux fix) ──────────────────
# Overwrites ONLY the interp string bytes (original slot: 27 bytes, new:
# "/data/data/com.termux/ld" + NUL = 26). No segments/sections change, so
# Bun's embedded payload stays intact — patchelf (segment rewrite) segfaults
# this binary, do NOT use it here.
configure_binary() {
  [[ -x "$BIN" ]] || die "binary missing: $BIN"

  # Symlink: short interp path → real glibc loader.
  if [[ ! -w "$SHORT_LD_DIR" ]]; then
    die "cannot create symlink in $SHORT_LD_DIR (not writable)"
  fi
  ln -sfn "$GLIBC_LD" "$SHORT_LD"
  log "loader symlink: $SHORT_LD -> $GLIBC_LD"

  local want="$SHORT_LD"
  # Hard assertion: the interp string + NUL must fit the original 27-byte
  # PT_INTERP slot. Fail loudly instead of corrupting the binary if a future
  # Termux path change lengthens it.
  if [[ ${#want} -gt 26 ]]; then
    die "interp path is ${#want} bytes; the in-place slot holds at most 26: $want"
  fi
  if [[ ${#want} -ne 24 ]]; then
    warn "interp path is ${#want} bytes (expected 24): $want"
  fi
  python3 - "$BIN" "$want" <<'PYEOF'
import struct, sys
path, want = sys.argv[1], sys.argv[2].encode() + b"\x00"
if len(want) > 27:
    sys.exit(f"interp string {len(want)} bytes > 27-byte slot")
data = bytearray(open(path, "rb").read())
if data[:4] != b"\x7fELF" or data[4] != 2:
    sys.exit("not an ELF64 binary")
phoff = struct.unpack_from("<Q", data, 32)[0]
phentsize = struct.unpack_from("<H", data, 54)[0]
phnum = struct.unpack_from("<H", data, 56)[0]
for i in range(phnum):
    off = phoff + i * phentsize
    if struct.unpack_from("<I", data, off)[0] != 3:  # PT_INTERP
        continue
    poff = struct.unpack_from("<Q", data, off + 8)[0]
    psize = struct.unpack_from("<Q", data, off + 32)[0]
    old = data[poff:poff + psize].split(b"\x00")[0]
    if old == want.rstrip(b"\x00"):
        print(f"interp already {want.decode()!r} — no change")
        sys.exit(0)
    print(f"interp {old.decode()!r} -> {want.decode()!r}")
    assert psize >= len(want), "PT_INTERP slot too small"
    data[poff:poff + psize] = want + b"\x00" * (psize - len(want))
    open(path, "wb").write(bytes(data))
    sys.exit(0)
sys.exit("no PT_INTERP found")
PYEOF
  chmod 755 "$BIN"
  log "opencode2 PT_INTERP patched (native exec)"
}

# ── 5. Wrapper: `opencode2` on PATH that execs the patched binary ────────
ensure_wrapper() {
  mkdir -p "$WRAPPER_DIR"
  local content
  content="$(wrapper_body "$BIN")"
  if [ -f "$WRAPPER" ] && [ "$(cat "$WRAPPER")" = "$content" ]; then
    log "wrapper unchanged at $WRAPPER"
    return 0
  fi
  printf '%s\n' "$content" > "$WRAPPER"
  chmod +x "$WRAPPER"
  log "wrote wrapper $WRAPPER"
}

# ── 6. Pi agent wrapper (pi sessions prepend ~/.pi/agent/bin) ────────────
ensure_pi_wrapper() {
  [[ -d "$PI_BIN_DIR" ]] || {
    log "no pi agent bin dir ($PI_BIN_DIR) — skipping pi wrapper"
    return 0
  }
  local target="$PI_BIN_DIR/opencode2"
  local content
  content="$(wrapper_body "$BIN")"
  if [ -f "$target" ] && [ "$(cat "$target")" = "$content" ]; then
    log "pi wrapper unchanged at $target"
    return 0
  fi
  printf '%s\n' "$content" > "$target"
  chmod +x "$target"
  log "wrote pi wrapper $target"
}

# ── 7. ~/.bashrc: managed PATH block (wrapper dir on PATH, raw dir OFF) ───
ensure_bashrc() {
  local marker_top="# >>> opencode-termux (managed by setup-opencode-termux.sh) >>>"
  local marker_bot="# <<< opencode-termux (managed by setup-opencode-termux.sh) <<<"
  local block
  local upgrade_alias="alias opencode-upgrade='bash \"$SCRIPT_PATH\" --upgrade'"
  block="$marker_top
# opencode2 is PT_INTERP-patched to exec natively via the glibc loader
# (/data/data/com.termux/ld). The launcher is ~/.local/bin/opencode2; the raw
# ~/.opencode/bin dir is kept OFF PATH so bare 'opencode2' resolves to the
# launcher (and so stale unpatched binaries can't shadow it).
export PATH=\"\$HOME/.local/bin:\$PATH\"
# opencode2 upgrade: re-downloads the latest binary AND re-applies the
# PT_INTERP patch (self-updates ship a pristine, unpatched binary).
$upgrade_alias
$marker_bot"

  # Idempotency sentinel: the alias line is unique to the CURRENT block
  # version. A single-line -Fxq check avoids multiline-pattern grep pitfalls
  # (pi-uu-grep ORs the lines of a multiline -F pattern and would
  # false-positive on the old block).
  if [[ -f "$BASHRC" ]] && grep -Fxq "$upgrade_alias" "$BASHRC"; then
    log "PATH block unchanged in $BASHRC"
    return 0
  fi

  # Drop any previous managed block, then strip stale raw-binary exports (the
  # v1 installer appended one to ~/.bashrc) and standalone .local/bin exports
  # (owned by the managed blocks of the bun/opencode scripts). This block is
  # the single source of truth for those lines.
  if [[ -f "$BASHRC" ]]; then
    sed -i '/^# >>> opencode-termux (managed by setup-opencode-termux.sh) >>>$/,/^# <<< opencode-termux (managed by setup-opencode-termux.sh) <<<$/d' "$BASHRC"
    sed -i '\#^export PATH=.*\.opencode/bin.*\$#d
            \#^export PATH="\$HOME/.local/bin:\$PATH"$#d' "$BASHRC"
  fi
  printf '\n%s\n' "$block" >> "$BASHRC"
  log "managed PATH block appended to $BASHRC"
}

# ── 8. Verify ────────────────────────────────────────────────────────────
verify() {
  local v
  v="$("$BIN" --version 2>/dev/null)" || die "opencode2 does not exec natively (interp patch broken?)"
  log "opencode2 $v OK (native exec)"
  "$WRAPPER" --version >/dev/null 2>&1 \
    && log "wrapper OK: $WRAPPER" \
    || die "wrapper $WRAPPER failed to run"
  # The user's interactive Termux shell preloads the bionic libtermux-exec.so
  # (DT_NEEDED libc.so — bionic name), which breaks the glibc loader
  # ("invalid ELF header" on the ld linker-script libc.so). The wrapper must
  # survive that env.
  if [[ -f "${PREFIX:-/nonexistent}/lib/libtermux-exec.so" ]]; then
    LD_PRELOAD="$PREFIX/lib/libtermux-exec.so" "$WRAPPER" --version >/dev/null 2>&1 \
      && log "wrapper OK under bionic termux-exec LD_PRELOAD" \
      || die "wrapper fails under bionic termux-exec LD_PRELOAD — unset LD_PRELOAD missing?"
  fi
  if command -v opencode2 >/dev/null 2>&1; then
    log "shell command: $(command -v opencode2)"
  else
    warn "wrapper not on PATH yet — open a new shell"
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────
main() {
  local force="" mode="setup"
  case "${1:-}" in
    --force)   force="force" ;;
    --upgrade) force="force"; mode="upgrade" ;;
  esac

  if ! is_termux; then
    log "not Termux — running the official opencode v2 installer unchanged"
    run_official_installer modify-path || die "official installer failed"
    log "Done."
    exit 0
  fi

  log "Termux opencode v2 $mode (idempotent)"
  [[ "$mode" = "upgrade" ]] && log "--upgrade: re-downloading the latest binary (auto-repatch)"
  ensure_prereqs
  ensure_glibc
  install_via_official "$force"
  configure_binary
  ensure_wrapper
  ensure_pi_wrapper
  ensure_bashrc
  verify
  log "Done."
}

main "$@"
