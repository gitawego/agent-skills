#!/usr/bin/env bash
# Clear NetEase Cloud Music's local cache/state so the client rebuilds it cleanly.
#
# Why this exists: the client renders its whole UI inside CEF (page scheme
# orpheus://orpheus/pub/app.html) and serves every cover through its own
# custom scheme, orpheus://cache/?<url>, handled by native code that keeps an
# on-disk cache. Under Wine, cache/state written by one session is not
# reliably readable by the next, so a later launch paints grey placeholders
# for covers that need a cache lookup.
#
# Cookies and login live in the CEF profile (webapp<NN>/Cookies) and are
# deliberately preserved; only HTTP/GPU caches inside the profile are removed.
#
# Usage:
#   clear-client-state.sh [--dry-run] [--data-dir <path>]
set -uo pipefail

DRY_RUN=0
DATA_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --data-dir) shift; DATA_DIR="${1:-}" ;;
    -h|--help) sed -n '1,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

find_data_dirs() {
  local roots=()
  [ -n "${NETEASE_PREFIX:-}" ] && roots+=("$NETEASE_PREFIX")
  [ -n "${WINEPREFIX:-}" ] && roots+=("$WINEPREFIX")
  roots+=("$HOME/Programs" "$HOME/Games" "$HOME/.wine" "$HOME/.local/share/wineprefixes" "$HOME/.var/app/com.usebottles.bottles/data/bottles/bottles")
  for root in "${roots[@]}"; do
    [ -d "$root" ] || continue
    find "$root" -maxdepth 9 -type d -path '*/AppData/Local/NetEase/CloudMusic' 2>/dev/null
  done | sort -u
}

if [ -n "$DATA_DIR" ]; then
  DIRS=("$DATA_DIR")
else
  mapfile -t DIRS < <(find_data_dirs)
fi

if [ "${#DIRS[@]}" -eq 0 ]; then
  echo "error: no NetEase CloudMusic data dir found." >&2
  echo "Pass --data-dir <.../AppData/Local/NetEase/CloudMusic> or set WINEPREFIX." >&2
  exit 1
fi

for DATA in "${DIRS[@]}"; do
  [ -d "$DATA" ] || continue
  echo "==> $DATA"

  for item in Cache webdata dumps localdata localware info; do
    if [ -e "$DATA/$item" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        echo "    would remove $item"
      else
        rm -rf "${DATA:?}/$item" && echo "    removed $item"
      fi
    fi
  done

  if [ "$DRY_RUN" -eq 0 ]; then
    mkdir -p "$DATA/Cache/Cache"
  fi

  # CEF profile caches. The profile dir is named after the bundled Chromium
  # major (webapp91 today); a client update shipping newer CEF renames it, so
  # glob rather than hardcode. Cookies/Login Data in the profile are kept.
  for prof in "$DATA"/webapp*/; do
    [ -d "$prof" ] || continue
    for sub in "Cache" "GPUCache" "Code Cache"; do
      if [ -d "${prof}${sub}" ]; then
        if [ "$DRY_RUN" -eq 1 ]; then
          echo "    would remove ${prof}${sub}"
        else
          rm -rf "${prof}${sub}"
        fi
      fi
    done
    [ "$DRY_RUN" -eq 0 ] && echo "    cleared CEF caches in $(basename "$prof") (cookies kept)"
  done
done

[ "$DRY_RUN" -eq 1 ] && echo "(dry run: nothing changed)"
exit 0
