#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
DEFAULT_ELECTRON_VERSION="38.3.0"
DEFAULT_VERSION="3.0.46"

usage() {
  cat <<USAGE
Usage:
  $SCRIPT_NAME --version VERSION [--out DIR] [--install]
  $SCRIPT_NAME --dmg /path/to/MiniMax-Code.dmg [--out DIR] [--install]

Examples:
  $SCRIPT_NAME --version 3.0.46
  $SCRIPT_NAME --dmg "~/Downloads/MiniMax Code-3.0.46.dmg"
  $SCRIPT_NAME 3.0.46
  $SCRIPT_NAME "~/Downloads/MiniMax Code-3.0.46.dmg"

What it does:
  - Downloads the macOS DMG when --version is used:
      https://filecdn.minimax.chat/public/minimax-agent-prod/release/MiniMax%20Code-{version}.dmg
  - Extracts the Electron app from the DMG.
  - Downloads Linux x64 Electron ${DEFAULT_ELECTRON_VERSION}.
  - Builds a portable Linux directory in the current working directory.
  - Rebuilds better-sqlite3 for Electron ABI.
  - Replaces the bundled macOS opencode binary with a Linux opencode if available.

By default it does NOT install desktop entries, URL handlers, or modify ~/.local/bin.
Pass --install only after the user explicitly asks to install/register the app.

Options:
  --version VERSION       MiniMax Code version to download. Default: ${DEFAULT_VERSION}
  --dmg PATH             Existing DMG path. Skips download.
  --out DIR              Output directory. Default: ./MiniMax-Code-linux-{version}
  --electron-version V   Electron version. Default: ${DEFAULT_ELECTRON_VERSION}
  --opencode PATH        Linux opencode binary to bundle. Default: auto-detect from PATH, ~/.opencode/bin/opencode
  --install              Install after building: copy to ~/.local/opt, create ~/.local/bin symlink, register .desktop + URL schemes.
  --install-dir DIR      Install directory. Default: ~/.local/opt/minimax-code-{version}
  --replace-install      Allow replacing an existing install directory. Without this, install refuses to overwrite.
  --keep-work            Keep temporary work directory.
  -h, --help             Show this help.
USAGE
}

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || { err "Missing required command: $1"; exit 1; }; }
abs_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    ~/*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    *) printf '%s/%s\n' "$PWD" "$1" ;;
  esac
}

VERSION="$DEFAULT_VERSION"
DMG=""
OUT=""
ELECTRON_VERSION="$DEFAULT_ELECTRON_VERSION"
OPENCODE_BIN=""
KEEP_WORK=0
INSTALL=0
INSTALL_DIR=""
REPLACE_INSTALL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="${2:-}"; shift 2 ;;
    --dmg)
      DMG="$(abs_path "${2:-}")"; shift 2 ;;
    --out)
      OUT="$(abs_path "${2:-}")"; shift 2 ;;
    --electron-version)
      ELECTRON_VERSION="${2:-}"; shift 2 ;;
    --opencode)
      OPENCODE_BIN="$(abs_path "${2:-}")"; shift 2 ;;
    --install)
      INSTALL=1; shift ;;
    --install-dir)
      INSTALL_DIR="$(abs_path "${2:-}")"; shift 2 ;;
    --replace-install)
      REPLACE_INSTALL=1; shift ;;
    --keep-work)
      KEEP_WORK=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    --*)
      err "Unknown option: $1"; usage; exit 1 ;;
    *)
      if [ -f "$(abs_path "$1")" ] && [ -z "$DMG" ]; then
        DMG="$(abs_path "$1")"
      elif [ -z "$VERSION" ] || [ "$VERSION" = "$DEFAULT_VERSION" ]; then
        VERSION="$1"
      else
        err "Unexpected argument: $1"; usage; exit 1
      fi
      shift ;;
  esac
done

[ -n "$VERSION" ] || VERSION="$DEFAULT_VERSION"
[ -n "$OUT" ] || OUT="$(abs_path "MiniMax-Code-linux-${VERSION}")"

need_cmd 7z
need_cmd curl
need_cmd unzip
need_cmd node
need_cmd npm
need_cmd file
need_cmd find
need_cmd cp
need_cmd grep
need_cmd sed
need_cmd tar
need_cmd make
need_cmd g++
need_cmd python3

WORK="$(mktemp -d -t minimax-code-linux-build.XXXXXX)"
cleanup() {
  if [ "$KEEP_WORK" -eq 0 ]; then
    rm -rf "$WORK"
  else
    warn "Keeping work directory: $WORK"
  fi
}
trap cleanup EXIT

if [ -z "$DMG" ]; then
  DMG="$WORK/MiniMax Code-${VERSION}.dmg"
  URL="https://filecdn.minimax.chat/public/minimax-agent-prod/release/MiniMax%20Code-${VERSION}.dmg"
  log "Downloading MiniMax Code ${VERSION} DMG"
  curl -fL --progress-bar -o "$DMG" "$URL"
else
  [ -f "$DMG" ] || { err "DMG not found: $DMG"; exit 1; }
  log "Using existing DMG: $DMG"
fi

log "Inspecting DMG"
file "$DMG"

EXTRACT_DIR="$WORK/dmg"
mkdir -p "$EXTRACT_DIR"
log "Extracting DMG"
7z x "$DMG" -o"$EXTRACT_DIR" -y >/dev/null

APP_DIR="$(find "$EXTRACT_DIR" -maxdepth 3 -type d -name 'MiniMax Code.app' | head -n 1)"
if [ -z "$APP_DIR" ]; then
  APP_DIR="$(find "$EXTRACT_DIR" -maxdepth 4 -type d -name '*.app' | head -n 1)"
fi
[ -n "$APP_DIR" ] || { err "Could not find .app inside DMG extraction"; exit 1; }
log "Found app: $APP_DIR"

APP_VERSION="$(node -e "const fs=require('fs'); const p='$APP_DIR/Contents/Resources/app.asar'; console.log('')" 2>/dev/null || true)"
PKG_VERSION=""

ASAR="$APP_DIR/Contents/Resources/app.asar"
UNPACKED="$APP_DIR/Contents/Resources/app.asar.unpacked"
BUNDLED_RES="$APP_DIR/Contents/Resources/resources"
[ -f "$ASAR" ] || { err "Missing app.asar: $ASAR"; exit 1; }
[ -d "$UNPACKED" ] || warn "Missing app.asar.unpacked; continuing"
[ -d "$BUNDLED_RES" ] || warn "Missing bundled resources directory; daemon may not work"

ASAR_OUT="$WORK/app"
log "Extracting app.asar"
npx --yes @electron/asar extract "$ASAR" "$ASAR_OUT" >/dev/null
if [ -f "$ASAR_OUT/package.json" ]; then
  PKG_VERSION="$(node -e "console.log(require('$ASAR_OUT/package.json').version || '')")"
  [ -n "$PKG_VERSION" ] && VERSION="$PKG_VERSION"
fi

ELECTRON_ZIP="$WORK/electron-v${ELECTRON_VERSION}-linux-x64.zip"
ELECTRON_DIR="$WORK/electron"
log "Downloading Electron ${ELECTRON_VERSION} linux-x64"
curl -fL --progress-bar -o "$ELECTRON_ZIP" "https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-x64.zip"
mkdir -p "$ELECTRON_DIR"
unzip -q "$ELECTRON_ZIP" -d "$ELECTRON_DIR"

log "Assembling portable Linux app: $OUT"
if [ -e "$OUT" ]; then
  err "Output already exists: $OUT"
  err "Remove it or pass --out to choose another directory."
  exit 1
fi
cp -a "$ELECTRON_DIR" "$OUT"
mv "$OUT/electron" "$OUT/minimax-code"
chmod +x "$OUT/minimax-code"
rm -rf "$OUT/resources/app.asar" "$OUT/resources/app.asar.unpacked"
cp -a "$ASAR_OUT" "$OUT/resources/app"
if [ -d "$UNPACKED" ]; then
  cp -a "$UNPACKED" "$OUT/resources/app.asar.unpacked"
else
  mkdir -p "$OUT/resources/app.asar.unpacked"
fi
if [ -d "$BUNDLED_RES" ]; then
  cp -a "$BUNDLED_RES" "$OUT/resources/resources"
fi
if [ -f "$APP_DIR/Contents/Resources/app-update.yml" ]; then
  cp -a "$APP_DIR/Contents/Resources/app-update.yml" "$OUT/resources/app-update.yml"
fi

log "Removing macOS metadata sidecar files"
find "$OUT/resources" -name '*:com.apple.*' -type f -delete || true


log "Patching Linux tray menu behavior"
TRAY_JS="$OUT/resources/app/dist/main/modules/tray/index.js"
if [ -f "$TRAY_JS" ]; then
  python - "$TRAY_JS" <<'PYTRAY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
old = """function applyTrayBehavior(t) {
    t.removeAllListeners('click');
    t.removeAllListeners('right-click');
    t.removeAllListeners('double-click');
    // Don't use setContextMenu — it intercepts left-click on macOS
    t.setContextMenu(null);
    t.on('click', () => {
        (0, window_1.bringToFront)();
    });
    t.on('right-click', () => {
        t.popUpContextMenu(createContextMenu());
    });
}
"""
new = """function applyTrayBehavior(t) {
    t.removeAllListeners('click');
    t.removeAllListeners('right-click');
    t.removeAllListeners('double-click');
    if (process.platform === 'linux') {
        // GNOME/AppIndicator often does not deliver Electron's right-click event.
        // Attaching the context menu is the portable Linux path and exposes Quit.
        t.setContextMenu(createContextMenu());
        t.on('click', () => {
            (0, window_1.bringToFront)();
        });
        return;
    }
    // Don't use setContextMenu — it intercepts left-click on macOS
    t.setContextMenu(null);
    t.on('click', () => {
        (0, window_1.bringToFront)();
    });
    t.on('right-click', () => {
        t.popUpContextMenu(createContextMenu());
    });
}
"""
if new in s:
    print('Linux tray patch already present')
elif old in s:
    p.write_text(s.replace(old, new))
    print('Linux tray patch applied')
else:
    print('WARNING: tray behavior block not found; leaving unchanged')
PYTRAY
else
  warn "Tray module not found; skipping Linux tray menu patch"
fi

cat > "$OUT/run-minimax-code" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
HERE="$(cd "$(dirname "$SELF")" && pwd)"
exec "$HERE/minimax-code" --no-sandbox "$@"
SH
chmod +x "$OUT/run-minimax-code"

log "Checking Electron runtime ABI"
ELECTRON_ABI="$(ELECTRON_RUN_AS_NODE=1 "$OUT/minimax-code" -e "process.stdout.write(process.versions.modules)")"
ELECTRON_NODE="$(ELECTRON_RUN_AS_NODE=1 "$OUT/minimax-code" -e "process.stdout.write(process.versions.node)")"
log "Electron ${ELECTRON_VERSION}: Node ${ELECTRON_NODE}, NODE_MODULE_VERSION ${ELECTRON_ABI}"

SQLITE_PKG="$OUT/resources/app/node_modules/better-sqlite3/package.json"
if [ -f "$SQLITE_PKG" ]; then
  SQLITE_VERSION="$(node -e "console.log(require('$SQLITE_PKG').version)")"
  log "Rebuilding better-sqlite3 ${SQLITE_VERSION} for Electron ${ELECTRON_VERSION}"
  NATIVE_WORK="$WORK/native-better-sqlite3"
  mkdir -p "$NATIVE_WORK"
  cd "$NATIVE_WORK"
  npm init -y >/dev/null
  npm install "better-sqlite3@${SQLITE_VERSION}" --ignore-scripts --omit=dev >/dev/null
  cd node_modules/better-sqlite3
  npm_config_runtime=electron \
  npm_config_target="$ELECTRON_VERSION" \
  npm_config_arch=x64 \
  npm_config_disturl=https://electronjs.org/headers \
  npm_config_build_from_source=true \
  npm_config_update_binary=false \
  npm run install --foreground-scripts
  SQLITE_NODE="$PWD/build/Release/better_sqlite3.node"
  file "$SQLITE_NODE"
  mkdir -p "$OUT/resources/app/node_modules/better-sqlite3/build/Release"
  cp -a "$SQLITE_NODE" "$OUT/resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  mkdir -p "$OUT/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release"
  cp -a "$SQLITE_NODE" "$OUT/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  cd "$OUT/resources/app"
  ELECTRON_RUN_AS_NODE=1 "$OUT/minimax-code" -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); if (db.prepare('select 42 x').get().x !== 42) process.exit(2); db.close(); console.log('better-sqlite3 ok')"
else
  warn "better-sqlite3 package not found; skipping sqlite rebuild"
fi

find_opencode() {
  if [ -n "$OPENCODE_BIN" ]; then
    printf '%s\n' "$OPENCODE_BIN"; return
  fi
  if command -v opencode >/dev/null 2>&1; then
    command -v opencode; return
  fi
  if [ -x "$HOME/.opencode/bin/opencode" ]; then
    printf '%s\n' "$HOME/.opencode/bin/opencode"; return
  fi
  printf '\n'
}

BUNDLED_OPENCODE="$OUT/resources/resources/opencode/opencode"
if [ -f "$BUNDLED_OPENCODE" ]; then
  OC="$(find_opencode)"
  if [ -n "$OC" ] && [ -x "$OC" ]; then
    if file "$OC" | grep -q 'ELF 64-bit'; then
      log "Replacing bundled macOS opencode with Linux opencode: $OC"
      cp -a "$BUNDLED_OPENCODE" "$BUNDLED_OPENCODE.macho.bak" || true
      cp -a "$OC" "$BUNDLED_OPENCODE"
      chmod +x "$BUNDLED_OPENCODE"
      "$BUNDLED_OPENCODE" --version 2>/dev/null | sed 's/^/opencode /' || true
    else
      warn "Detected opencode is not Linux ELF: $OC"
    fi
  else
    warn "No Linux opencode found. Agent execution may fail. Install opencode or pass --opencode PATH."
  fi
fi

write_desktop_file() {
  local app_dir="$1"
  local desktop_file="$2"
  cat > "$desktop_file" <<EOF
[Desktop Entry]
Name=MiniMax Code
Comment=MiniMax Code ${VERSION}
Exec=$app_dir/run-minimax-code %u
Terminal=false
Type=Application
Categories=Development;Utility;
StartupWMClass=MiniMax
MimeType=x-scheme-handler/minimax-cn;x-scheme-handler/minimax;x-scheme-handler/minimax-cn-test;x-scheme-handler/minimax-test;x-scheme-handler/minimax-cn-staging;x-scheme-handler/minimax-staging;
EOF
}

install_app() {
  local src="$1"
  local dest="${INSTALL_DIR:-$HOME/.local/opt/minimax-code-${VERSION}}"
  local desktop_dir="$HOME/.local/share/applications"
  local bin_dir="$HOME/.local/bin"
  local desktop_file="$desktop_dir/minimax-code.desktop"

  log "Installing MiniMax Code to $dest"
  mkdir -p "$(dirname "$dest")" "$desktop_dir" "$bin_dir"

  if [ -e "$dest" ]; then
    if [ "$REPLACE_INSTALL" -ne 1 ]; then
      err "Install directory already exists: $dest"
      err "Re-run with --replace-install after confirming you want to replace it."
      exit 1
    fi
    rm -rf "$dest"
  fi

  cp -a "$src" "$dest"
  chmod +x "$dest/minimax-code" "$dest/run-minimax-code"
  ln -sfn "$dest/run-minimax-code" "$bin_dir/minimax-code"

  write_desktop_file "$dest" "$desktop_file"
  chmod 644 "$desktop_file"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$desktop_dir" || true
  fi

  for scheme in minimax-cn minimax minimax-cn-test minimax-test minimax-cn-staging minimax-staging; do
    xdg-mime default minimax-code.desktop "x-scheme-handler/$scheme"
    xdg-settings set default-url-scheme-handler "$scheme" minimax-code.desktop 2>/dev/null || true
  done

  log "Install complete"
  printf 'Installed app: %s\n' "$dest"
  printf 'Launcher: %s\n' "$bin_dir/minimax-code"
  printf 'Desktop file: %s\n' "$desktop_file"
  printf 'SSO scheme: minimax-cn -> %s\n' "$(xdg-mime query default x-scheme-handler/minimax-cn 2>/dev/null || true)"
}

log "Creating portable desktop file template (not installed)"
write_desktop_file "$OUT" "$OUT/minimax-code.desktop"

if [ "$INSTALL" -eq 1 ]; then
  install_app "$OUT"
fi

log "Final verification"
file "$OUT/minimax-code"
if [ -f "$OUT/resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]; then
  file "$OUT/resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
fi
if [ -f "$BUNDLED_OPENCODE" ]; then
  file "$BUNDLED_OPENCODE"
fi

cat <<DONE

Build complete:
  $OUT

Run:
  "$OUT/run-minimax-code"

Portable build remains at the path above.

If you did not pass --install, nothing was installed. To enable SSO callbacks manually later, install/register the generated desktop file:
  mkdir -p ~/.local/share/applications
  cp "$OUT/minimax-code.desktop" ~/.local/share/applications/
  xdg-mime default minimax-code.desktop x-scheme-handler/minimax-cn
  xdg-mime default minimax-code.desktop x-scheme-handler/minimax

To install during conversion, re-run with --install. If replacing an existing install, also pass --replace-install.

Notes:
  - The daemon expects /mavis/health on its selected localhost port after app launch.
  - Remaining macOS-only optional modules may affect screenshot or terminal features until replaced.
DONE
