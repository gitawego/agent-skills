#!/usr/bin/env bash
#
# bootstrap-npm-publish.sh — set NPM_TOKEN + push first-publish tag, securely.
#
# Usage: bootstrap-npm-publish.sh PACKAGE_DIR_1 [PACKAGE_DIR_2 ...]
#
# For each package dir (must be a git repo with a GitHub remote):
#   1. Auto-detects package name, repo, current version
#   2. Asks for the tag version (default: current package.json version)
#   3. After token is captured (hidden input, never written to disk/env/history):
#      - gh secret set NPM_TOKEN -R <repo>  (with the new token)
#      - git tag v<X> && git push origin v<X>  (or skip if tag exists)
#   4. At the end: opens the Actions URL for each repo to watch
#
# Security:
#   - Token captured in a shell variable in memory only
#   - No file write, no env var export, no shell history (uses `read -rs` and stty
#     raw mode for char-by-char hidden input)
#   - Fed directly to `gh secret set` via stdin (the gh CLI also warns if the
#     token ever appears in a process listing)
#
# Reusable for any npm package bootstrap publish.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# ask_secret — hidden input with real-time * per char (raw mode), with a
# silent-line fallback for non-TTY environments.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3)
else
  BOLD=""; DIM=""; RESET=""; GREEN=""; YELLOW=""; fi

ask_secret() {
  local key="$1" prompt="$2" current input char
  printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"

  local stty_orig="" use_raw=false
  if [ -t 0 ] && command -v stty >/dev/null 2>&1; then
    stty_orig=$(stty -g 2>/dev/null || true)
    if [[ -n "$stty_orig" ]] && stty -echo -icanon min 1 time 0 2>/dev/null; then
      use_raw=true
    fi
  fi

  if $use_raw; then
    input=""
    while IFS= read -rsn1 char 2>/dev/null; do
      if [[ -z "$char" ]] || [[ "$char" == $'\n' ]] || [[ "$char" == $'\r' ]]; then
        break
      fi
      if [[ "$char" == $'\x7f' ]] || [[ "$char" == $'\b' ]]; then
        if [[ -n "$input" ]]; then
          input="${input%?}"
          printf '\b \b'
        fi
        continue
      fi
      if [[ "$char" == $'\x03' ]]; then
        stty "$stty_orig" 2>/dev/null || true
        printf '\n'
        kill -INT $$
      fi
      input+="$char"
      printf '*'
    done
    stty "$stty_orig" 2>/dev/null || true
    printf '\n'
  else
    IFS= read -rs input || true
    printf '\n'
    if [[ -n "$input" ]]; then
      local n=${#input}
      printf '  %s[received: %s (%d chars)]%s\n' \
        "$DIM" "$(printf '%*s' "$n" '' | tr ' ' '*')" "$n" "$RESET"
    fi
  fi

  printf -v "$key" '%s' "$input"
}

# ──────────────────────────────────────────────────────────────────────────
# arg parsing + per-package detection
# ──────────────────────────────────────────────────────────────────────────

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 PACKAGE_DIR_1 [PACKAGE_DIR_2 ...]" >&2
  echo "  Each PACKAGE_DIR must be a git repo with a GitHub remote." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Error: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

declare -a PKG_DIRS=()
declare -a PKG_NAMES=()
declare -a PKG_REPOS=()
declare -a PKG_BRANCHES=()
declare -a PKG_TAGS=()
declare -a PKG_DEFAULT_TAGS=()

echo ""
printf '%sDetecting packages...%s\n' "$BOLD" "$RESET"
echo ""

for dir in "$@"; do
  if [[ -z "$dir" ]]; then
    printf '  %s⚠%s empty arg, skipping (likely a paste artifact)\n' \
      "$YELLOW" "$RESET" >&2
    continue
  fi
  if [[ ! -d "$dir" ]]; then
    echo "  ✗ $dir: not a directory" >&2
    exit 1
  fi
  if [[ ! -d "$dir/.git" ]]; then
    echo "  ✗ $dir: not a git repo" >&2
    exit 1
  fi
  if [[ ! -f "$dir/package.json" ]]; then
    echo "  ✗ $dir: no package.json" >&2
    exit 1
  fi

  name=$(cd "$dir" && node -p "require('./package.json').name" 2>/dev/null || echo "?")
  version=$(cd "$dir" && node -p "require('./package.json').version" 2>/dev/null || echo "?")
  repo=$(cd "$dir" && git remote get-url origin 2>/dev/null \
    | sed -E 's|.*github\.com[:/](.+)$|\1|; s|\.git$||' \
    | head -1)
  branch=$(cd "$dir" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")

  if [[ "$repo" == "?" || -z "$repo" ]]; then
    echo "  ✗ $dir: no GitHub remote" >&2
    exit 1
  fi

  PKG_DIRS+=("$dir")
  PKG_NAMES+=("$name")
  PKG_REPOS+=("$repo")
  PKG_BRANCHES+=("$branch")
  PKG_DEFAULT_TAGS+=("v$version")

  printf '  %s✓%s %-30s %-30s @ %-20s default tag %s\n' \
    "$GREEN" "$RESET" "$name" "$repo" "$branch" "v$version"
done

echo ""
printf '%sConfirm tags:%s (Enter to accept default; type a different version like 0.2.0 to override)\n' \
  "$BOLD" "$RESET"
for i in "${!PKG_NAMES[@]}"; do
  printf '  %s [%s] tag [v]: ' "${PKG_NAMES[$i]}" "${PKG_BRANCHES[$i]}"
  read -r v
  if [[ -n "$v" ]]; then
    v="${v#v}"  # strip leading v if user typed it
    PKG_TAGS+=("v$v")
  else
    PKG_TAGS+=("${PKG_DEFAULT_TAGS[$i]}")
  fi
done

echo ""
printf '%sFinal plan:%s\n' "$BOLD" "$RESET"
for i in "${!PKG_NAMES[@]}"; do
  printf '  • %s → tag %s (on %s)\n' \
    "${PKG_NAMES[$i]}" "${PKG_TAGS[$i]}" "${PKG_BRANCHES[$i]}"
done
echo ""
printf '  Will: set NPM_TOKEN in each repo, then push each tag.\n'
echo ""

read -rp "Proceed? [y/N] " confirm
[[ "$confirm" =~ ^[Yy] ]] || { echo "Aborted."; exit 1; }

# ──────────────────────────────────────────────────────────────────────────
# Capture the token (hidden, in memory only)
# ──────────────────────────────────────────────────────────────────────────

echo ""
printf '%sPaste the npm token below (input is hidden).%s\n' "$BOLD" "$RESET"
printf '  Token: '
ask_secret NPM_TOKEN "Paste the npm token:"

if [[ -z "${NPM_TOKEN:-}" ]]; then
  echo "Error: empty token." >&2
  exit 1
fi

# Quick sanity check — npm tokens are typically npm_ + base62-ish
if [[ ! "$NPM_TOKEN" =~ ^npm_ ]]; then
  printf '  %s⚠ Token does not start with npm_ — continuing anyway. Press Enter if intentional.%s\n' \
    "$YELLOW" "$RESET"
  read -r _
fi

echo ""
printf '%sSetting NPM_TOKEN + pushing tags...%s\n' "$BOLD" "$RESET"

declare -a ACTIONS_URLS=()

for i in "${!PKG_NAMES[@]}"; do
  dir="${PKG_DIRS[$i]}"
  name="${PKG_NAMES[$i]}"
  repo="${PKG_REPOS[$i]}"
  tag="${PKG_TAGS[$i]}"
  branch="${PKG_BRANCHES[$i]}"

  echo ""
  printf '%s[%d/%d] %s%s\n' "$BOLD" "$((i+1))" "${#PKG_NAMES[@]}" "$name" "$RESET"

  # Set GH secret
  if printf '%s' "$NPM_TOKEN" | gh secret set NPM_TOKEN -R "$repo" 2>&1; then
    printf '  %s✓%s NPM_TOKEN set on %s\n' "$GREEN" "$RESET" "$repo"
  else
    printf '  %s✗ failed to set NPM_TOKEN on %s — check gh auth and repo access%s\n' \
      "$YELLOW" "$repo" "$RESET"
    exit 1
  fi

  # Push tag (skip if it already exists locally or remotely)
  cd "$dir"
  if git rev-parse "$tag" >/dev/null 2>&1; then
    printf '  %s•%s tag %s already exists locally — pushing to be safe\n' \
      "$DIM" "$RESET" "$tag"
    git push origin "$tag" 2>&1 | tail -3
  elif git ls-remote --tags origin "$tag" 2>/dev/null | grep -q "$tag"; then
    printf '  %s•%s tag %s already on remote — nothing to push\n' \
      "$DIM" "$RESET" "$tag"
  else
    git tag "$tag"
    git push origin "$tag" 2>&1 | tail -3
  fi

  ACTIONS_URLS+=("https://github.com/$repo/actions/workflows/release.yml")
done

# ──────────────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────────────

echo ""
printf '%s%s✓ Done — NPM_TOKEN set + tags pushed. Open the Actions tabs:%s\n\n' \
  "$BOLD" "$GREEN" "$RESET"

for url in "${ACTIONS_URLS[@]}"; do
  printf '  %s\n' "$url"
done

echo ""
printf '%sAfter each Publish job is green, switch to Trusted Publishing (OIDC):%s\n' \
  "$BOLD" "$RESET"
for dir in "${PKG_DIRS[@]}"; do
  printf '  bash /home/hlu/workspace/agent-skills/scripts/setup-npm-trusted-publishing.sh %s\n' "$dir"
done

# Wipe the token from memory (best-effort — bash doesn't guarantee this)
unset NPM_TOKEN
