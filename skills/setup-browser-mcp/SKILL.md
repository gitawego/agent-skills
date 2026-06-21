---
name: setup-browser-mcp
description: Install Chromium in the user's home directory and configure chrome-devtools-mcp and @playwright/mcp for a no-sudo Linux setup. Use this skill when the user says "set up browser MCP", "configure chrome devtools MCP", "install playwright MCP", "I get a chrome MCP error", "MCP failed to connect", "install chrome in home", or asks to onboard a Linux machine (CachyOS / Arch / Debian / Ubuntu / no-sudo container) for browser automation. Also use when an MCP browser tool is failing — this skill can re-verify the connection and fix common flags. Supports both **Claude Code** and **opencode**: the script is identical, the MCP config file and verification command differ. The skill is idempotent: re-running is safe and reports what is already in place. The install script is bundled under scripts/install_playwright.sh — no external dependencies required.
---

# setup-browser-mcp

Install a Chromium-family browser in `$HOME` (no sudo required) and wire up `chrome-devtools-mcp` and `@playwright/mcp` for browser automation. Works for both **Claude Code** and **opencode**.

This skill is for **Linux users without root**, especially CachyOS / Arch / Debian containers where the system Chrome cannot be installed normally and Playwright's chrome channel would invoke `apt-get` internally and fail.

## When to use

- User wants to **install** browser MCPs on a fresh machine.
- User gets **`Status: ✘ Failed to connect`** from `claude mcp get` **or** a server missing from `opencode mcp list`.
- User asks "how do I get a working headless Chrome for Claude / opencode?".
- A browser tool errors with `Could not find Chromium`, `chrome-linux64 not found`, or `Failed to launch browser`.

## When NOT to use

- The user is on macOS or has a system Chrome at `/Applications/Google Chrome.app` (use the upstream `chrome-devtools-mcp` README directly).
- The user wants to add a *third* MCP server (e.g., Lighthouse, axe) — out of scope.
- The user is on a non-Linux platform (Windows: use the platform installer; macOS: see above).

## What this skill produces

A working state where:

- `~/.local/bin/chrome` (or `/opt/google/chrome/chrome`) is a runnable Chromium binary.
- The host's MCP config declares both `chrome-devtools` and `playwright` with flags that work on a no-sudo Linux box.
- `claude mcp get <name>` returns `Status: ✔ Connected` **or** `opencode mcp list` shows both servers as `connected`.
- A short final report tells the user the resolved chrome path, the config file location, the host in use, and how to invoke each server.

## Detecting the host

The browser install (step 1) is host-agnostic. The config file (step 2) and verification command (step 4) differ. Detect once at the start:

```bash
command -v opencode  >/dev/null && echo HOST=opencode
command -v claude    >/dev/null && echo HOST=claude
```

If both are present, prefer **opencode** (the newer config) and only fall through to claude if the user explicitly mentions Claude Code. If neither is present, ask the user.

Use `HOST` as a variable throughout the rest of the workflow to pick the right config file and verify command.

## Workflow

Run these four steps in order. Each step is idempotent: if the prior state is already correct, report it and move on.

### 1. Install browser binary

Delegate to the bundled installer at `scripts/install_playwright.sh`. The script handles package-manager detection (apt / pacman / none), runtime deps, and userspace symlinking, and is **idempotent**: if a usable browser already exists, it prints the resolved path and exits 0 without re-installing.

Run it as:

```bash
SCRIPT="<absolute-path-to-this-skill>/scripts/install_playwright.sh"
bash "$SCRIPT"
```

If you don't have the skill's install path at hand, find the directory containing this `SKILL.md` and run from there:

```bash
bash "$(dirname "$(readlink -f SKILL.md)")/scripts/install_playwright.sh"
```

Read the script's final output. The relevant signals:

- `Browser path: <path>` — chrome is at a stable path. **Capture this path** for step 2.
- `Installed: <chrome version>` — version string is informational.
- `Chrome already installed at <path>` (idempotent re-run) — reuse that path.
- `WARNING: ...` lines (apt/pacman missing, no sudo, etc.) — the install may have succeeded anyway; trust `Browser path:` if it appears. If the path is missing AND warnings are present, surface this to the user.
- `ERROR: failed to install...` exit 1 — surface this to the user and stop. Do not continue to MCP config without a working browser.

### 2. Write MCP config

#### If `HOST=opencode`

opencode reads `opencode.json` (or `opencode.jsonc`) from these locations, in precedence order:

1. `<cwd>/opencode.json` (project scope)
2. `<cwd>/.opencode/opencode.json` (project scope, hidden dir)
3. `~/.config/opencode/opencode.json` (user scope)

The active config is whichever file wins. To find it, run:

```bash
for f in "./opencode.json" "./.opencode/opencode.json" "$HOME/.config/opencode/opencode.json"; do
  [ -f "$f" ] && { echo "FOUND=$f"; break; }
done
```

If **multiple** opencode configs exist, the project-level one wins for the current cwd but the user-level one may already declare `playwright` (as is common). Treat the project file as the source of truth for new servers; warn the user if a user-level file also declares an entry with conflicting args.

**Edit whichever file is found, or `~/.config/opencode/opencode.json` if none exist yet.** Use `jq` to merge safely — never blindly overwrite unrelated keys like `provider`:

```bash
CONFIG="$HOME/.config/opencode/opencode.json"
CHROME="/home/<user>/.local/bin/chrome"  # from step 1
jq --arg c "$CHROME" '
  .mcp //= {} |
  .mcp.playwright = {
    "type": "local",
    "command": ["npx","@playwright/mcp@latest","--executable-path",$c,"--no-sandbox","--headless"],
    "enabled": true
  } |
  .mcp["chrome-devtools"] = {
    "type": "local",
    "command": ["npx","-y","chrome-devtools-mcp@latest","--executable-path",$c,"--no-sandbox","--headless","--isolated","--no-usage-statistics"],
    "enabled": true
  }
' "$CONFIG" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
```

**Idempotency:** if a server already exists with the same args, leave it. If it exists with *different* args (e.g., missing `--isolated`, has `--autoConnect`), update it. Never delete unrelated `mcp` entries.

**opencode has no approval flow** — there is no analog of Claude Code's "Allow" prompt. As long as `enabled: true` is set, the server is loaded.

**Note:** opencode does **not** read `.mcp.json` (that file is for Claude Code / Cline). If you see a `.mcp.json` in the project root, leave it alone unless the user is on Claude Code.

#### If `HOST=claude`

Choose the target config file based on scope:

- **Project scope** → `<cwd>/.mcp.json` (travels with the repo). Project-scope entries are **not** auto-approved — the user must click "Allow" on next Claude startup.
- **User scope** → `~/.claude.json` (available across projects). User-scope entries are **auto-approved**.

Prefer project scope for project work; user scope for personal dotfiles. The `claude mcp add --scope <user|project>` CLI pre-approves the server (regardless of file). Writing `.mcp.json` or `~/.claude.json` directly does not pre-approve — use the CLI form if you want a one-step setup.

Use these args for both servers (the no-sudo Linux defaults that work on CachyOS containers and Debian without sudo):

```json
{
  "command": "npx",
  "args": [
    "-y",
    "<package>@latest",
    "--executable-path",
    "<resolved chrome path from step 1>",
    "--no-sandbox",
    "--headless",
    "--isolated",
    "--no-usage-statistics"
  ]
}
```

`<package>` is `@playwright/mcp` for the playwright server and `chrome-devtools-mcp` for the devtools server.

**Idempotency:** if `.mcp.json` already has both servers with the same args, do nothing. If a server has *different* args, update it. Never delete unrelated entries.

**If `claude` CLI is on PATH:** the equivalent one-liner (which also pre-approves) is:

```bash
claude mcp add --scope <user|project> --transport stdio \
  chrome-devtools -- npx -y chrome-devtools-mcp@latest \
    --executable-path <path> --no-sandbox --headless --isolated --no-usage-statistics

claude mcp add --scope <user|project> --transport stdio \
  playwright -- npx -y @playwright/mcp@latest \
    --executable-path <path> --no-sandbox --headless
```

#### Why each flag (both hosts)

- `--executable-path <path>` — point at the userspace chrome. Required: chrome-devtools-mcp will otherwise try the system path and fail.
- `--no-sandbox` — required when running as root, in a container without setuid sandbox, or in a CachyOS user namespace. Without this, Chrome refuses to launch with `Failed to move to new namespace`.
- `--headless` — no display on a server. Skip only if the user explicitly wants a headed browser.
- `--isolated` (chrome-devtools-mcp only) — temp user-data-dir, auto-cleaned, prevents collision with the user's real profile and with the playwright server's profile. **Do NOT also pass `--autoConnect`**: that flag requires a pre-existing Chrome with remote debugging on the local profile, and causes the MCP health check to report `Failed to connect` even when the server is healthy. With `--headless --isolated` the server launches its own Chrome on first MCP call.
- `--no-usage-statistics` (chrome-devtools-mcp only) — opt out of Google telemetry. Matches `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

**Important:** the playwright server is `stdio` transport; do not add `--transport http`. In opencode, transport is implied by `type: "local"` — do not add transport flags.

### 3. Approve project-scope servers (Claude Code only)

If you wrote to `.mcp.json` directly (not via `claude mcp add`), the user must approve the server on next Claude startup. There is no CLI to pre-approve `.mcp.json` entries written by hand. **Tell the user this** in the final report.

To pre-approve project-scope servers, use the `claude mcp add --scope project` form (see Step 2) — the CLI registers the approval as part of the add.

User-scope servers are auto-approved regardless of how they're added.

**Skip this step entirely on opencode** — no approval flow.

### 4. Verify

#### If `HOST=opencode`

```bash
opencode mcp list
```

Expect both `playwright` and `chrome-devtools` to show as `connected`. If a server is missing or shows an error:

- The chrome path may be wrong — re-run step 1 and confirm the path matches.
- The args may be malformed — print the current `mcp.<name>.command` array and compare against the snippet in step 2.
- The user may need to **restart opencode** to pick up changes to `opencode.json`.
- If the wrong config file was edited, find all `opencode.json` files (`find ~ /mnt -name opencode.json 2>/dev/null`) and reconcile.

If `opencode mcp list` itself errors, fall back to a manual MCP handshake — this works in CI where there's no opencode install:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"hc","version":"0"}}}' \
  | timeout 15 npx -y <package>@latest <args> 2>&1 | grep -E '"result"|"error"'
```

A valid `initialize` response means the server process is healthy; the connection failure is then an opencode startup issue, not a config issue.

#### If `HOST=claude`

For each server in the config, run:

```bash
claude mcp get <name>
```

Expect `Status: ✔ Connected`. If it shows `✘ Failed to connect`:

- The chrome path may be wrong — re-run step 1 and confirm the path matches.
- The args may be malformed — print the current args and compare against the snippet in step 2.
- The user may need to **restart Claude Code** to pick up a freshly written `.mcp.json` or to load a server that was just added via `claude mcp add`.

If `claude mcp get` itself errors, fall back to the same manual handshake as above. A valid `initialize` response means the server process is healthy.

If even the manual handshake fails, the most common cause is the chrome path: re-run step 1 to print `Browser path:`, and confirm `--executable-path` in step 2 points to the **same path**.

## Final report

Tell the user, in this order:

1. **Chrome path** that was used (e.g., `/home/<user>/.local/bin/chrome`).
2. **Host** detected (claude / opencode) and **config file** that was written, plus scope (project / user / opencode: project / user).
3. **Connection status** for each server.
4. **Action required**:
   - claude project scope + hand-edited `.mcp.json` → "approve the MCP on next Claude startup".
   - any host with `Failed to connect` / disconnected → "restart the host (Claude Code / opencode)".
5. **How to test**:
   - claude: "Run `/mcp` to see the registered servers; try `browser_navigate` on a URL."
   - opencode: "Run `opencode mcp list`; the browser tools (e.g., `browser_navigate` for playwright, `navigate` for chrome-devtools) appear in the tool list on next opencode restart."

## Things this skill does not do

- Install system packages other than what `scripts/install_playwright.sh` does (gbm, alsa-lib).
- Configure headed Chrome (the `--headless` flag is the default).
- Set up remote-debugging connections to an *existing* Chrome instance (use `--browser-url` manually, document that choice is out of scope here).
- Wire up the Lighthouse / heap-snapshot / screencast categories — those are tool-level opt-in flags, not setup concerns.
- Configure remote (OAuth) MCP servers — out of scope; this skill is browser-local only.

## Reference

- `scripts/install_playwright.sh` (bundled in this skill) — single source of truth for browser install. Idempotent: re-running is safe and reports the current chrome path.
- Chrome DevTools MCP flags reference: https://github.com/ChromeDevTools/chrome-devtools-mcp#configuration
- Playwright MCP flags reference: https://github.com/microsoft/playwright-mcp
- opencode MCP docs: https://opencode.ai/docs/mcp-servers/
