---
name: chrome-devtools-mcp-pi
description: Set up Chrome DevTools MCP for pi-mcp-adapter on memory-constrained, proot/container Linux (Termux proot-distro, arm64). Installs the Playwright headless-shell (lightweight arm64 Chromium), an idempotent CDP launcher (start-cdp.sh), and the ~/.pi/agent/mcp.json config that auto-starts the browser on server connect via the adapter's !command env. Use when the user says "set up chrome MCP", "chrome-devtools not working", "browser tools fail in pi", "MCP failed to connect", "install headless chrome for pi", or when full Chrome/Chromium crashes or OOMs a constrained box. Idempotent and self-contained: SKILL.md + scripts/ only, no external dependencies beyond curl, unzip, npm, and bash.
---

# chrome-devtools-mcp-pi

Wire `chrome-devtools-mcp` into pi-mcp-adapter using the **Playwright headless-shell** — the purpose-built lightweight headless Chromium — on machines where full Chrome/Chromium fails:

- **proot / containers** where Chrome's child-process model (network service, GPU, zygote, crashpad) crashes under syscall emulation.
- **arm64 Linux** where Google Chrome stable ships only x86_64, and Chrome for Testing has no `linux-arm64` builds.
- **low-RAM boxes** (OOM killer takes out Chrome + the agent).

The headless-shell runs as a **persistent CDP endpoint** (`127.0.0.1:9222`); chrome-devtools-mcp connects via `--browserUrl`, so only one lean browser process exists and no agent tool has to launch Chrome itself.

## When to use

- User wants Chrome DevTools MCP working inside **pi** (pi-mcp-adapter), on a proot / container / arm64 / low-memory box.
- `chrome-devtools` MCP shows `Failed to connect`, or browser tools error with `Target closed`, `Network service crashed`, or the whole terminal OOMs when Chrome starts.
- `pi` shows `MCP: 0/0 servers` after adding a chrome server to `~/.pi/agent/mcp.json` (config was written after startup — needs `/reload`).

## When NOT to use

- **claude / opencode hosts** → use the `setup-browser-mcp` skill (writes `.mcp.json` / `opencode.json` with `--executable-path`).
- macOS / Windows, or a normal desktop Linux with working system Chrome → follow the upstream `chrome-devtools-mcp` README.

## What this skill produces

- `~/.cache/ms-playwright/headless-shell-<rev>/headless_shell` — Playwright's arm64 headless-shell binary.
- `start-cdp.sh` (this skill's `scripts/`) — idempotent CDP launcher: starts headless-shell detached if down, no-op if already up, `--force` to restart, `--status` to check.
- `~/.pi/agent/mcp.json` — `chrome-devtools` server entry whose `env.CDP_READY` is `!bash <skill>/scripts/start-cdp.sh --ensure`. The adapter runs that command at **server-connect time**, so CDP is always up before any browser tool call — no agent needs to remember to start the browser first.
- `npm` install of `chrome-devtools-mcp@1.6.0` in `~/workspace/chrome-mcp` (path overridable via env).

## Workflow

Run the bundled setup script — it is **idempotent**: re-running is safe, reports what is already in place, and never force-reinstalls unless `--force` is given.

```bash
SKILL_DIR="$(cd "$(dirname "$(readlink -f SKILL.md 2>/dev/null || echo "$0")")" && pwd)"
bash "$SKILL_DIR/scripts/setup-chrome-mcp.sh"
```

Or for a skill path you already know:

```bash
bash /path/to/chrome-devtools-mcp-pi/scripts/setup-chrome-mcp.sh
```

Read the script's final report — it prints the resolved browser path, CDP URL, launcher path, and config path.

### After setup: reload pi

The adapter reads `~/.pi/agent/mcp.json` at session startup. After the first setup (or any config rewrite), **the user must run `/reload` in pi** (or restart pi). Then:

```text
/mcp                      → chrome-devtools should appear with 29 tools
mcp({ search: "navigate" })  → tools resolve
mcp({ tool: "chrome_devtools_list_pages" }) → returns live page list
```

### Verifying without pi

```bash
bash <skill>/scripts/start-cdp.sh --status        # CDP up? prints version
curl -s http://127.0.0.1:9222/json/version        # headless-shell banner
```

### Manual fallback (if the script cannot download)

1. **Browser:** get the Playwright headless-shell arm64 zip for the pinned revision and extract to `~/.cache/ms-playwright/headless-shell-<rev>/` (flat layout — the binary sits at the dir root). Confirm with `<binary> --version` (should print `Chromium <ver>`).
2. **Launcher:** copy `scripts/start-cdp.sh` from this skill and run `bash start-cdp.sh`.
3. **Config:** write `~/.pi/agent/mcp.json` with the `CDP_READY` `!command` env entry (the setup script shows the exact shape), then `/reload`.

## Idempotency contract

| Step | Re-run behavior |
|------|-----------------|
| headless-shell binary | skips if `--version` works |
| chrome-devtools-mcp npm | skips if the server js exists |
| start-cdp.sh | skips (it lives in the skill) |
| mcp.json | skips if `CDP_READY` env already present |
| CDP endpoint | `start-cdp.sh` no-ops if port 9222 already responds |

`--force` re-downloads the browser, reinstalls npm, and rewrites the config. `--status` prints a checklist and changes nothing.

## Environment overrides

All defaults can be overridden by env vars (useful when `~/workspace` differs):

- `CDP_HEADLESS_SHELL` — path to the headless-shell binary (default `~/.cache/ms-playwright/headless-shell-1234/headless_shell`)
- `CDP_PORT` — CDP port (default `9222`)
- `CDP_USER_DATA_DIR` — browser profile dir (default `~/.cdp-headless`)
- `CHROME_MCP_DIR` — npm install dir for chrome-devtools-mcp (default `~/workspace/chrome-mcp`)

## Why headless-shell and not full Chrome

- Full Chrome/Chromium spawns network-service / GPU / crashpad child processes that crash under proot (observed: `Network service crashed or was terminated, restarting service` loop) and OOM low-RAM boxes.
- Chrome for Testing has **no linux-arm64** builds; Google Chrome stable is x86_64-only for Linux.
- headless-shell is the lean headless-only binary Playwright ships for exactly this: fewer child processes, low RSS, no crashpad, and it binds CDP in ~1s.
- `--no-sandbox --disable-setuid-sandbox` are required (proot can't create user namespaces); `--disable-gpu --disable-dev-shm-usage` avoid GPU/shm issues in containers.

## Reference

- Scripts bundled in this skill: `scripts/setup-chrome-mcp.sh` (idempotent full setup), `scripts/start-cdp.sh` (idempotent CDP launcher).
- Chrome DevTools MCP: https://github.com/ChromeDevTools/chrome-devtools-mcp
- pi-mcp-adapter (config, `!command` env, `/reload`): https://www.npmjs.com/package/pi-mcp-adapter
- Playwright browser downloads (headless-shell arm64): https://playwright.dev/docs/browsers
