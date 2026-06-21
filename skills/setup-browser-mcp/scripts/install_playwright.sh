#!/usr/bin/env bash
# Installs a browser for the Playwright MCP plugin.
#
# Behaviour matrix:
#   - Chrome already at /opt/google/chrome/chrome OR ~/.local/bin/chrome
#     → noop, exit 0.
#   - Package manager detection (apt / pacman / none):
#       * apt → install runtime deps via apt-get
#       * pacman (Arch, CachyOS, Manjaro, etc.) → install runtime deps via pacman
#       * none → WARN, skip dep install; user must install manually
#   - Browser channel:
#       * On Debian/Ubuntu + x86_64 → `npx playwright install chrome`
#         (Chrome for Testing puts the binary at /opt/google/chrome/chrome).
#       * Everywhere else (Arch, ARM64, missing sudo, etc.) →
#         `npx playwright install chromium` and symlink to ~/.local/bin/chrome
#         (userspace path; the consumer's .mcp.json should reference this path).
#
# Exit codes:
#   0 — a usable browser binary is available at a known path after the run.
#   1 — `npx playwright install` itself failed AND no browser binary exists.
#       Soft-failures (missing sudo, missing system deps) only WARN.
#
# In container environments, pass --no-sandbox to the Playwright MCP server
# (configured in .mcp.json).
set -uo pipefail

CHROME_PATH_SYSTEM="/opt/google/chrome/chrome"
CHROME_PATH_USER="$HOME/.local/bin/chrome"

# ---------------------------------------------------------------------------
# Already-installed early exit
# ---------------------------------------------------------------------------
for candidate in "$CHROME_PATH_SYSTEM" "$CHROME_PATH_USER"; do
 if [ -x "$candidate" ]; then
   echo "Chrome already installed at $candidate: $("$candidate" --version 2>/dev/null || echo '<version unavailable>')"
   exit 0
 fi
done

# ---------------------------------------------------------------------------
# Sudo detection
# ---------------------------------------------------------------------------
HAVE_SUDO=0
if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
 HAVE_SUDO=1
fi

# ---------------------------------------------------------------------------
# Package manager + runtime deps
# ---------------------------------------------------------------------------
# Map: pkg manager → installer command (after sudo) → deps for headless Chrome/Chromium.
PKG_MANAGER=""
if command -v apt-get >/dev/null 2>&1; then
 PKG_MANAGER="apt"
elif command -v pacman >/dev/null 2>&1; then
 PKG_MANAGER="pacman"
fi

# Arch package names: gbm provides libgbm.so, alsa-lib provides libasound.so.
# Debian names: libgbm1 + libasound2t64 (Ubuntu 24+).
APT_DEPS=(libgbm1 libasound2t64)
PACMAN_DEPS=(gbm alsa-lib)

install_deps() {
 local pm="$1"
 if [ "$HAVE_SUDO" -ne 1 ]; then
   echo "WARNING: no passwordless sudo — skipping $pm dep install." >&2
   if [ "$pm" = "apt" ]; then
     echo "         sudo apt-get install -y --no-install-recommends ${APT_DEPS[*]}" >&2
   else
     echo "         sudo pacman -S --needed --noconfirm ${PACMAN_DEPS[*]}" >&2
   fi
   return 0
 fi
 if [ "$pm" = "apt" ]; then
   echo "Installing system dependencies (apt: ${APT_DEPS[*]})..."
   if ! sudo apt-get update -qq; then
     echo "WARNING: apt-get update failed — Chrome may fail to launch if deps are missing." >&2
     return 0
   fi
   if ! sudo apt-get install -y --no-install-recommends "${APT_DEPS[@]}"; then
     echo "WARNING: failed to install ${APT_DEPS[*]} — Chrome may fail to launch." >&2
     return 0
   fi
 else
   echo "Installing system dependencies (pacman: ${PACMAN_DEPS[*]})..."
   if ! sudo pacman -S --needed --noconfirm "${PACMAN_DEPS[@]}"; then
     echo "WARNING: pacman install of ${PACMAN_DEPS[*]} failed — Chrome may fail to launch." >&2
     return 0
   fi
 fi
}

if [ -n "$PKG_MANAGER" ]; then
 install_deps "$PKG_MANAGER"
else
 echo "WARNING: no supported package manager found (need apt-get or pacman)." >&2
 echo "         Install Chrome's runtime deps manually before launching." >&2
fi

# ---------------------------------------------------------------------------
# Browser install
# ---------------------------------------------------------------------------
ARCH=$(uname -m)
echo "Detected architecture: $ARCH"

# The "chrome" channel on Playwright uses an internal apt-get on Linux to
# pull Google-Chrome-stable system deps. That fails on Arch/CachyOS (no apt),
# and on Debian without passwordless sudo. On non-apt systems, OR when sudo
# is unavailable, fall through to chromium — which is a self-contained tarball
# under ~/.cache/ms-playwright and works on any distro with the right .so files.
USE_CHROME_CHANNEL=0
if [ "$PKG_MANAGER" = "apt" ] && [ "$HAVE_SUDO" -eq 1 ] && [ "$ARCH" = "x86_64" ]; then
 USE_CHROME_CHANNEL=1
fi

INSTALL_OK=0
if [ "$USE_CHROME_CHANNEL" -eq 1 ]; then
 echo "Installing Chrome for Testing (Debian/Ubuntu x86_64 with sudo)..."
 if npx playwright install chrome; then
   INSTALL_OK=1
 else
   echo "WARNING: 'npx playwright install chrome' failed — falling back to chromium." >&2
   if npx playwright install chromium; then
     INSTALL_OK=1
   else
     echo "WARNING: 'npx playwright install chromium' also failed." >&2
   fi
 fi
else
 echo "Installing Chromium (non-Debian, or no sudo, or non-x86_64)..."
 if npx playwright install chromium; then
   INSTALL_OK=1
 else
   echo "WARNING: 'npx playwright install chromium' failed." >&2
 fi
fi

# ---------------------------------------------------------------------------
# Resolve final binary path + symlink
# ---------------------------------------------------------------------------
# Newer Playwright builds lay out chromium as chromium-<rev>/chrome-linux64/chrome
# (vs. older chromium-<rev>/chrome-linux/chrome). Try both.
resolve_chromium_bin() {
 local d
 if [ ! -d "$HOME/.cache/ms-playwright" ]; then return 1; fi
 d=$(find "$HOME/.cache/ms-playwright" -maxdepth 1 -name 'chromium-*' -type d 2>/dev/null | sort -V | tail -1)
 [ -z "$d" ] && return 1
 if [ -x "$d/chrome-linux64/chrome" ]; then
   echo "$d/chrome-linux64/chrome"; return 0
 fi
 if [ -x "$d/chrome-linux/chrome" ]; then
   echo "$d/chrome-linux/chrome"; return 0
 fi
 return 1
}

RESOLVED_PATH=""
if [ "$USE_CHROME_CHANNEL" -eq 1 ] && [ "$INSTALL_OK" -eq 1 ] && [ -x "$CHROME_PATH_SYSTEM" ]; then
 # Chrome for Testing puts the binary at /opt/google/chrome/chrome already.
 RESOLVED_PATH="$CHROME_PATH_SYSTEM"
else
 CHROMIUM_BIN="$(resolve_chromium_bin || true)"
 if [ -n "$CHROMIUM_BIN" ]; then
   if [ "$HAVE_SUDO" -eq 1 ]; then
     echo "Symlinking $CHROMIUM_BIN -> $CHROME_PATH_SYSTEM"
     sudo mkdir -p "$(dirname "$CHROME_PATH_SYSTEM")" || true
     if sudo ln -sf "$CHROMIUM_BIN" "$CHROME_PATH_SYSTEM"; then
       RESOLVED_PATH="$CHROME_PATH_SYSTEM"
     fi
   fi

   # Fallback userspace symlink — used when sudo isn't available, or when
   # the system-path symlink failed for any other reason. The consumer's
   # .mcp.json should reference this path on machines without sudo.
   if [ -z "$RESOLVED_PATH" ]; then
     mkdir -p "$(dirname "$CHROME_PATH_USER")"
     if ln -sf "$CHROMIUM_BIN" "$CHROME_PATH_USER"; then
       echo "Symlinked $CHROMIUM_BIN -> $CHROME_PATH_USER (userspace)."
       echo "         Set executablePath in .mcp.json to: $CHROME_PATH_USER"
       RESOLVED_PATH="$CHROME_PATH_USER"
     fi
   fi
 fi
fi

# ---------------------------------------------------------------------------
# Final report
# ---------------------------------------------------------------------------
if [ -n "$RESOLVED_PATH" ] && [ -x "$RESOLVED_PATH" ]; then
 echo "Installed: $("$RESOLVED_PATH" --version 2>/dev/null || echo '<version unavailable>')"
 echo "Browser path: $RESOLVED_PATH"
 exit 0
fi

if [ "$INSTALL_OK" -eq 1 ]; then
 echo "WARNING: browser installed via Playwright but could not be linked to a stable path." >&2
 echo "         Look under $HOME/.cache/ms-playwright/chromium-*/chrome-linux{64,}/chrome" >&2
 echo "         and configure .mcp.json's executablePath manually." >&2
 exit 0
fi

echo "ERROR: failed to install Chrome/Chromium and no existing binary was found." >&2
exit 1