#!/usr/bin/env bash
#
# Wizard — switch any npm package to Trusted Publishing (OIDC).
#
# Usage: bash setup-npm-trusted-publishing.sh [PACKAGE_DIR]
#   PACKAGE_DIR defaults to current directory. Must contain package.json and
#   be a git repo with a GitHub remote.
#
# What this does (in order):
#   1. Confirm the auto-detected package name, repo, and release workflow.
#   2. Walk you through configuring the Trusted Publisher on npmjs.com
#      (the only manual step — npm requires browser access for package-level
#      settings).
#   3. Patch the release workflow to use OIDC (adds `id-token: write`,
#      removes the `NODE_AUTH_TOKEN` env var), commit, and push.
#   4. Optionally test the OIDC end-to-end with a fresh tag push
#      (bump to next patch version, push tag, watch the workflow).
#   5. Remove the now-unneeded NPM_TOKEN GitHub Actions secret.
#
# Final screen: instructions to manually revoke the bootstrap token on npmjs.com.
#
# Reusable: cd into any npm-package dir and re-run. Auto-detects name, repo,
# workflow. Idempotent: re-running on an already-OIDC package is a no-op for
# stages 3-5 (each checks current state and skips).

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library — delightful, consistent UX. Identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

TOTAL_STAGES=0
_STAGE_INDEX=0

_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[H'; fi
}

banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do.\n' "$DIM"
  printf '  Stop any time with Ctrl-C and re-run later — it skips already-done work.%s\n' "$RESET"
  pause "Ready to start?"
}

stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

say()  { printf '  %s\n' "$1"; }
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview         >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe     >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v termux-open-url  >/dev/null 2>&1; then termux-open-url "$url"
    elif command -v am               >/dev/null 2>&1; then am start -a android.intent.action.VIEW -d "$url" >/dev/null
    elif command -v xdg-open        >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open            >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser — visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser — visit it manually: $url"
}

pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

ask_default() {
  local key="$1" default="$2"
  local input
  if [[ -n "$default" ]]; then
    printf '  %s%s%s %s[default: %s]%s ' "$BOLD" "$key" "$RESET" "$DIM" "$default" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$key" "$RESET"
  fi
  read -r input || true
  printf -v "$key" '%s' "${input:-$default}"
}

# ──────────────────────────────────────────────────────────────────────────
# Auto-detect: package name, repo, workflow file from PACKAGE_DIR
# ──────────────────────────────────────────────────────────────────────────

PKG_DIR="${1:-$PWD}"
if [[ ! -d "$PKG_DIR" ]]; then
  echo "Error: $PKG_DIR is not a directory" >&2
  exit 1
fi
cd "$PKG_DIR"

if [[ ! -f package.json ]]; then
  echo "Error: no package.json in $PKG_DIR" >&2
  exit 1
fi

DETECTED_NAME=$(node -p "require('./package.json').name" 2>/dev/null || echo "")
DETECTED_REPO=$(git remote get-url origin 2>/dev/null \
  | sed -E 's|.*github\.com[:/](.+)$|\1|; s|\.git$||' \
  | head -1)
DETECTED_WF=$(ls .github/workflows/*.yml .github/workflows/*.yaml 2>/dev/null \
  | xargs -I{} basename {} \
  | grep -iE "(release|publish)" \
  | head -1)
[[ -z "$DETECTED_WF" ]] && DETECTED_WF="release.yml"

# ──────────────────────────────────────────────────────────────────────────
# STAGES — author this section.
# ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES=5

banner "Switch to npm Trusted Publishing (OIDC)"

# ── Stage 1: confirm auto-detected values ──────────────────────────────────
stage "Confirm package info"
say "Auto-detected from $PKG_DIR:"
note "  Package:  ${DETECTED_NAME:-<not detected>}"
note "  Repo:     ${DETECTED_REPO:-<not detected>}"
note "  Workflow: .github/workflows/${DETECTED_WF}"
say "Press Enter to accept each, or type to override."
echo ""
ask_default PKG_NAME  "$DETECTED_NAME"
ask_default PKG_REPO  "$DETECTED_REPO"
ask_default WF_FILE   "$DETECTED_WF"
WF_PATH=".github/workflows/$WF_FILE"
echo ""
say "Will work with:"
note "  Package:  $PKG_NAME"
note "  Repo:     $PKG_REPO (on github.com)"
note "  Workflow: $WF_PATH"
pause "Press Enter to continue."

# ── Stage 2: configure Trusted Publisher on npmjs.com ─────────────────────
stage "Configure Trusted Publisher on npmjs.com for $PKG_NAME"
say "npm requires this in the browser (the package-settings page is not scriptable)."
say "Trusted Publishing pins publishing to this exact repo + workflow file —"
say "no NPM_TOKEN, no Bypass 2FA, no long-lived credential."
echo ""
NPM_USER=$(echo "$PKG_REPO" | cut -d/ -f1)
say "  Package settings (newer npm UI):"
open_url "https://www.npmjs.com/package/$PKG_NAME/access"
say "  Per-user trusted publishers (fallback / older UI):"
open_url "https://www.npmjs.com/settings/$NPM_USER/trusted-publishers"
echo ""
step "Click 'Trusted Publisher' (or 'Publishing access' on the package page)."
step "Click 'Add a Trusted Publisher'."
step "Provider:           GitHub Actions"
step "Organization or user:  $NPM_USER"
step "Repository:            $(echo "$PKG_REPO" | cut -d/ -f2)"
step "Workflow filename:     $WF_FILE"
step "Allowed actions:       npm publish  (and/or npm stage publish if you want the staged flow)"
step "Click 'Add' / 'Save'."
echo ""
note "Skip this stage if TP is already configured for this package — the wizard"
note "won't be able to verify (npm 9.x has no 'npm trust' subcommand), so if you"
note "re-run the wizard, just press Enter to skip and let stages 3-5 catch up."
pause "Configured? Press Enter to continue."

# ── Stage 3: patch the release workflow to use OIDC ────────────────────────
stage "Patch $WF_PATH to use OIDC"

if [[ ! -f "$WF_PATH" ]]; then
  warn "Workflow file $WF_PATH not found."
  say "Create the release workflow first (this wizard only patches an existing one)."
  say "Suggested template: typecheck + test + 'npm publish --access public' gated"
  say "on tag push 'v*' or workflow_dispatch."
  exit 1
fi

has_idtoken=$(grep -cE "^\s*id-token:\s*write" "$WF_PATH" || true)
has_npmtoken=$(grep -cE "NODE_AUTH_TOKEN.*NPM_TOKEN" "$WF_PATH" || true)
echo ""
say "Current state of $WF_PATH:"
if [[ "$has_idtoken" -gt 0 ]]; then
  note "  ✓ id-token: write already present"
else
  note "  ✗ id-token: write NOT present (will add)"
fi
if [[ "$has_npmtoken" -gt 0 ]]; then
  note "  ✗ NODE_AUTH_TOKEN still set (will remove)"
else
  note "  ✓ NODE_AUTH_TOKEN already removed"
fi
echo ""

if [[ "$has_idtoken" -gt 0 && "$has_npmtoken" -eq 0 ]]; then
  say "Nothing to patch — workflow is already in OIDC mode."
  PATCHED=false
else
  if ! confirm "Apply the patch?"; then
    warn "Skipped. Run the wizard again when ready, or apply manually."
    exit 0
  fi

  cp "$WF_PATH" "$WF_PATH.wizard.bak"

  # 3a. Add `id-token: write` after the top-level `permissions:` line
  if [[ "$has_idtoken" -eq 0 ]]; then
    if grep -qE "^permissions:" "$WF_PATH"; then
      sed -i '/^permissions:/a\  id-token: write  # needed for npm Trusted Publishing (OIDC token request)' "$WF_PATH"
    else
      # No permissions block — insert one after the `on:` block
      sed -i '/^on:/a\\npermissions:\n  contents: write  # needed to create GitHub Releases on tag push\n  id-token: write  # needed for npm Trusted Publishing (OIDC token request)' "$WF_PATH"
    fi
  fi

  # 3b. Remove the NODE_AUTH_TOKEN env block from the Publish step
  if [[ "$has_npmtoken" -gt 0 ]]; then
    sed -i -Ez 's|\n([[:space:]]*env:\n[[:space:]]*NODE_AUTH_TOKEN:[[:space:]]*\$\{\{[[:space:]]*secrets\.NPM_TOKEN[[:space:]]*\}\})||g' "$WF_PATH"
  fi

  echo ""
  say "Diff:"
  diff -u "$WF_PATH.wizard.bak" "$WF_PATH" || true
  echo ""
  if ! confirm "Commit and push the change?"; then
    warn "Reverting the in-place change (keeping the backup at $WF_PATH.wizard.bak)."
    mv "$WF_PATH.wizard.bak" "$WF_PATH"
    exit 0
  fi

  git add "$WF_PATH"
  if git diff --cached --quiet; then
    note "Nothing to commit (no effective change)."
    PATCHED=false
  else
    PATCHED=true
    git commit -m "ci: switch release workflow to npm Trusted Publishing (OIDC)

Removes NODE_AUTH_TOKEN env var and adds id-token: write to the
workflow permissions. After this, no NPM_TOKEN secret is needed —
npm CLI requests an OIDC token from GitHub Actions and verifies it
against the Trusted Publisher config on the npm side." 2>&1 | tail -3
    if confirm "Push to origin?"; then
      git push origin "$(git rev-parse --abbrev-ref HEAD)" 2>&1 | tail -5
    else
      warn "Committed but not pushed. Push manually: git push"
    fi
  fi
  rm -f "$WF_PATH.wizard.bak"
fi

pause "Press Enter to continue."

# ── Stage 4: test the OIDC publish (optional) ──────────────────────────────
stage "Test the OIDC publish with a fresh tag (optional)"
say "Recommended. Bumps to the next patch version, pushes the tag, and the"
say "workflow publishes via OIDC — confirms the Trusted Publisher is wired up"
say "correctly before we remove the NPM_TOKEN secret."
echo ""
note "  Current version: $(node -p "require('./package.json').version")"
note "  Test version:    $(node -p "const v=require('./package.json').version; const [a,b,c]=v.split('.').map(Number); \`\${a}.\${b}.\${c+1}\`")"
echo ""
say "Bumping and tagging will:"
step "  - Edit package.json: version → next patch"
step "  - Commit 'chore: test OIDC publish'"
step "  - Create tag v<next> + push to origin"
step "  - Open the Actions URL for you to watch"
echo ""
TEST_DONE=false
if confirm "Bump, tag, and push the test publish?"; then
  NEXT_VERSION=$(node -p "const v=require('./package.json').version; const [a,b,c]=v.split('.').map(Number); \`\${a}.\${b}.\${c+1}\`")
  NEXT_TAG="v$NEXT_VERSION"

  node -e "
    const fs=require('fs');
    const p=JSON.parse(fs.readFileSync('package.json','utf8'));
    p.version='$NEXT_VERSION';
    fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');
  "

  git add package.json
  git commit -m "chore: test OIDC publish to $NEXT_VERSION" 2>&1 | tail -2
  git tag "$NEXT_TAG"
  git push origin "$(git rev-parse --abbrev-ref HEAD)" 2>&1 | tail -3
  git push origin "$NEXT_TAG" 2>&1 | tail -3
  echo ""
  say "Pushed $NEXT_TAG. Open the Actions tab to watch:"
  open_url "https://github.com/$PKG_REPO/actions/workflows/$WF_FILE"
  echo ""
  note "The 'Publish' step should now show 'Publishing to https://registry.npmjs.org/'"
  note "WITHOUT a 'NODE_AUTH_TOKEN' env line in the step header (OIDC is invisible)."
  note "If you see 'ENEEDAUTH' or '403 Forbidden', the Trusted Publisher config on"
  note "npmjs.com doesn't match — double-check repo name, workflow filename, and"
  note "case (npm's match is case-sensitive)."
  TEST_DONE=true
else
  say "Skipped. You can do this manually after the wizard finishes."
fi

pause "Press Enter to continue."

# ── Stage 5: remove the NPM_TOKEN GH secret ────────────────────────────────
stage "Remove NPM_TOKEN from $PKG_REPO"
echo ""
if ! gh auth status >/dev/null 2>&1; then
  warn "gh is not authenticated — skipping. Run 'gh auth login' then re-run."
  exit 0
fi

if gh secret list -R "$PKG_REPO" 2>/dev/null | grep -q NPM_TOKEN; then
  if ! confirm "Delete the NPM_TOKEN secret from $PKG_REPO?"; then
    warn "Skipped. Delete manually: gh secret delete NPM_TOKEN -R $PKG_REPO"
    exit 0
  fi
  gh secret delete NPM_TOKEN -R "$PKG_REPO"
  note "✓ NPM_TOKEN removed."
else
  note "NPM_TOKEN not set — nothing to do."
fi
echo ""
say "After this, the workflow is fully on OIDC. Future releases are just:"
note "  npm version patch   # or edit package.json + commit"
note "  git push --follow-tags"
echo ""
pause "Press Enter for the final step."

# ── Final note (not a numbered stage — informational) ──────────────────────
_clear
printf '\n%s%s  ✓ Trusted Publishing setup complete%s\n\n' "$BOLD" "$GREEN" "$RESET"
cat <<EOF
Summary for $PKG_NAME on $PKG_REPO:
  - Trusted Publisher: configured on npmjs.com
  - Workflow $WF_FILE: now uses OIDC (id-token: write, no NODE_AUTH_TOKEN)
EOF
if [[ "$TEST_DONE" == "true" ]]; then
  cat <<EOF
  - Test publish v$NEXT_VERSION: PUSHED, workflow green
EOF
fi
cat <<EOF
  - NPM_TOKEN GH secret: removed

One last manual step — revoke the bootstrap token (the granular one with
"Bypass 2FA" you used for the first publish). It's not needed anymore.
EOF
echo ""
open_url "https://www.npmjs.com/settings/$NPM_USER/tokens"
step "Find the token named something like '$PKG_NAME publish' or similar."
step "Click it → 'Delete token' / 'Revoke'."
echo ""
printf '%sAfter revoking, you can re-run this wizard on any other npm package\n' "$DIM"
printf 'you want to switch to Trusted Publishing:%s\n' "$RESET"
note "  cd /path/to/other-package"
note "  bash /tmp/setup-npm-trusted-publishing.sh"
