---
name: chrome-devtools-mcp-pi
description: Set up Chrome DevTools MCP for pi-mcp-adapter on arm64 Termux (native or proot-distro) and low-RAM boxes. Makes Playwright's headless-shell work on Termux native despite the glibc-vs-bionic libc mismatch (patchelf + Termux glibc rootfs + runner wrapper), installs the persistent CDP endpoint, and wires ~/.pi/agent/mcp.json so the adapter auto-starts the browser via a CDP_READY !command env. Use when the user says "set up chrome MCP", "chrome-devtools not working", "playwright not working on termux", "headless chrome for termux", "blank screenshots from chrome MCP", "browser tools fail in pi", "MCP failed to connect", or full Chrome/Chromium crashes or OOMs a constrained box. Idempotent and self-contained: SKILL.md + scripts/ only, needs curl, unzip, dpkg, patchelf, npm, and the Termux glibc repo.
---

# chrome-devtools-mcp-pi

Wire `chrome-devtools-mcp` into pi-mcp-adapter using the **Playwright headless-shell** — the purpose-built lightweight headless Chromium — on machines where full Chrome/Chromium fails:

- **arm64 Termux native (bionic libc)** — the tricky case, solved below.
- **proot-distro / containers** — Chrome's child-process model (network service, GPU, zygote, crashpad) crashes under syscall emulation, and full Chrome OOMs low-RAM boxes.
- **low-RAM boxes** (OOM killer takes out Chrome + the agent).

The headless-shell runs as a **persistent CDP endpoint** (`127.0.0.1:9222`); chrome-devtools-mcp connects via `--browserUrl`, so only one lean browser process exists and no agent tool has to launch Chrome itself.

## The core knowledge: Playwright on Termux

**Does Playwright ship a prebuilt android arm64 binary?** Yes for the browser itself: the CDN publishes `chromium-headless-shell-linux-arm64.zip` (~111 MB) and `chromium-linux-arm64.zip` (~195 MB) for every revision (the revision is pinned in `playwright-core/browsers.json`; e.g. Playwright 1.62.x → rev 1234 → Chromium 151). Verify directly:

```bash
curl -sIL https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1234/chromium-headless-shell-linux-arm64.zip
# HTTP 200 = prebuilt arm64 exists
```

**The real problem is libc, not architecture.** Playwright's arm64 builds are **glibc** ELF binaries. Termux native runs **bionic** libc, so the binary cannot exec: `cannot execute: required file not found` (no glibc interpreter), then a cascade of missing shared libraries. Two ways to run it:

| Environment | libc | How the headless-shell runs |
|---|---|---|
| **proot-distro** (e.g. Ubuntu arm64) | glibc inside the distro | Runs as-is, exactly like desktop Linux. The skill's original flow. |
| **Termux native** | bionic | Needs the **glibc shim** — see below. |

### The Termux-native (bionic) glibc shim

Termux has a full glibc ecosystem (`glibc-repo` → `glibc`, `glibc-runner`, `*-glibc` packages) rooted at `$PREFIX/glibc` (here `/data/data/com.termux/files/usr/glibc`). The shim has five parts; the setup script does all of them:

1. **patchelf the binary** — set `PT_INTERP` to `$PREFIX/glibc/lib/ld-linux-aarch64.so.1` and rpath to `$ORIGIN/compat:$ORIGIN:$PREFIX/glibc/lib`. Native exec is required so `/proc/self/exe` resolves to `headless_shell`: via `ld.so`-style launch Chromium looks for `icudtl.dat` next to the *loader* and dies with `Invalid file descriptor to ICU data`.
2. **`compat/libc.so -> libc.so.6`** — Chromium `dlopen("libc.so")` at runtime; the glibc prefix's `libc.so` is a GNU **ld linker script** (text), which the loader rejects as `invalid ELF header`. The symlink (placed first in rpath/`LD_LIBRARY_PATH`) satisfies it.
3. **Unset bionic `LD_PRELOAD`** — Termux exports `libtermux-exec-ld-preload.so` (bionic shim needing bionic's `LIBC` version node). The glibc loader can't load it: `version 'LIBC' not found`. `glibc-runner` itself unsets it; the runner wrapper does too.
4. **glibc shared libraries** — install `*-glibc` apt packages from the glibc repo (glib, fontconfig + fonts, X11 family, dbus, alsa, mesa/libgbm, sqlite…). Five libs are **not** in the repo and must be extracted from Ubuntu/Debian **arm64 .debs** into `$PREFIX/glibc/lib`: `libnspr4` + `libnss3` (with its `nss/` module dir), `libatk-1.0`, `libXdamage`, `libudev`, `libatspi`, `libXRes`. They're glibc-linked and compatible with the repo's glibc (2.43).
5. **FONTCONFIG_FILE/PATH to the glibc rootfs config** — glibc fontconfig reads `/etc/fonts/fonts.conf`, which on Termux resolves to bionic's `/etc/fonts` (no `fonts.conf`). Without its own config, Skia dies with `FATAL: SkFontMgr_FontConfigInterface ... Not implemented` and **every screenshot comes out blank white** even though `document.title` works.

The runner wrapper (`headless-shell-runner.sh`) bundles 3, 5 and the library path:

```bash
#!/data/data/com.termux/files/usr/bin/bash
HS_DIR="$(cd "$(dirname "$(readlink -f "$0")")/chrome-linux" && pwd)"
unset LD_PRELOAD
export LD_LIBRARY_PATH="$HS_DIR/compat:/data/data/com.termux/files/usr/glibc/lib"
export FONTCONFIG_FILE="/data/data/com.termux/files/usr/glibc/etc/fonts/fonts.conf"
export FONTCONFIG_PATH="/data/data/com.termux/files/usr/glibc/etc/fonts"
exec "$HS_DIR/headless_shell" "$@"
```

## When to use

- User wants Chrome DevTools MCP working inside **pi** (pi-mcp-adapter), on Termux (native or proot), arm64, or low-memory boxes.
- `chrome-devtools` MCP shows `Failed to connect`, browser tools error with `Target closed`, `Network service crashed`, or the terminal OOMs when Chrome starts.
- **Playwright "installed" but every launch fails on Termux** (glibc/bionic mismatch).
- Screenshots come back **blank white** while page titles work.
- `pi` shows `MCP: 0/0 servers` after adding a chrome server to `~/.pi/agent/mcp.json` (config was written after startup — needs `/reload`).

## When NOT to use

- **claude / opencode hosts** → use the `setup-browser-mcp` skill (writes `.mcp.json` / `opencode.json` with `--executable-path`).
- macOS / Windows, or desktop Linux with working system Chrome → follow the upstream `chrome-devtools-mcp` README.

## Install

The setup script is **idempotent and self-contained** — re-running is safe, reports what is already in place, and never force-reinstalls unless `--force` is given.

```bash
SKILL_DIR="$(cd "$(dirname "$(readlink -f SKILL.md 2>/dev/null || echo "$0")")" && pwd)"
bash "$SKILL_DIR/scripts/setup-chrome-mcp.sh"
```

First run on a fresh Termux box needs the glibc repo (the script errors with instructions if missing):

```bash
pkg install glibc-repo patchelf && pkg update
```

What the script installs (each step skips when already satisfied):

1. **Tool prereqs**: `curl`, `unzip`, `dpkg`, `patchelf` (Termux main) + checks for `glibc-runner`.
2. **glibc runtime deps**: `glib-glibc fontconfig-glibc freetype-glibc libdrm-glibc mesa-glibc` + the X11 family + `dbus-glibc alsa-lib-glibc libsqlite-glibc ttf-dejavu-glibc` from the glibc repo; then the five deb-only libs (nspr4, nss3, atk, Xdamage, udev, atspi, XRes) from Ubuntu ports / Debian mirrors into `$PREFIX/glibc/lib`.
3. **headless-shell** rev 1234 (Chromium 151, arm64) → `~/.cache/ms-playwright/headless-shell-1234/chrome-linux/headless_shell`; patchelf'd + `compat/libc.so` shim + runner wrapper.
4. **chrome-devtools-mcp@1.6.0** npm → `~/workspace/chrome-mcp` (overridable via `CHROME_MCP_DIR`).
5. **`~/.pi/agent/mcp.json`** — `chrome-devtools` entry with `lifecycle: "lazy"` +
   `idleTimeout: 5` (pi-mcp-adapter spawns the MCP server only when a browser
   tool is first called, and shuts it down after 5 min idle), plus a
   `cdp-lifecycle.sh` wrapper command that **ensures CDP is up before the
   server starts** and **tears down the whole headless-Chrome tree when the
   server exits** (idle shutdown / crash / kill). No browser tool ever has to
   start Chrome — and nothing lingers after the MCP server goes idle.
6. **Verification** — starts CDP, checks `/json/version`, then a real **render check**: navigates a `data:` green page and decodes the screenshot's center pixel (proves fonts + compositor work, not just the socket).

`--status` prints the full checklist and changes nothing. `--force` re-downloads the browser, reinstalls npm, and rewrites the config.

### Env overrides

All defaults overridable: `CDP_HEADLESS_SHELL` (runner path), `CDP_PORT` (9222), `CDP_USER_DATA_DIR` (`~/.cdp-headless`), `CHROME_MCP_DIR` (`~/workspace/chrome-mcp`), `GLIBC_PREFIX` (`$PREFIX/glibc`), `PLAYWRIGHT_CACHE` (`~/.cache/ms-playwright`).

## After setup: reload pi

The adapter reads `~/.pi/agent/mcp.json` at session startup. After first setup (or any config rewrite), **the user must run `/reload` in pi** (or restart pi). Then:

```text
/mcp                          → chrome-devtools should appear with 29 tools (lazy: not connected until first use)
mcp({ search: "navigate" })   → tools resolve
mcp({ tool: "chrome_devtools_list_pages" }) → live page list (spawns CDP on demand)
```

After 5 min idle the MCP server and headless Chrome are shut down automatically; the next tool call starts them again.

## Verifying without pi

```bash
bash <skill>/scripts/start-cdp.sh --status   # CDP up? prints version
curl -s http://127.0.0.1:9222/json/version   # headless-shell banner
# full render smoke (needs node):
bash <skill>/scripts/setup-chrome-mcp.sh     # re-run ends with the render check
```

## Troubleshooting matrix

| Symptom | Cause | Fix |
|---|---|---|
| `cannot execute: required file not found` | glibc interpreter missing under bionic | patchelf PT_INTERP → `$PREFIX/glibc/lib/ld-linux-aarch64.so.1` (script step 3) |
| `error while loading shared libraries: libXXX.so.0` | missing glibc dep | `*-glibc` apt package or deb extraction (script step 2) |
| `libc.so: invalid ELF header` | Chromium dlopens `libc.so`; prefix's copy is an ld script | `compat/libc.so -> libc.so.6` + rpath/LD_LIBRARY_PATH |
| `version 'LIBC' not found (required by ... libtermux-exec-ld-preload.so)` | bionic `LD_PRELOAD` leaks into glibc loader | `unset LD_PRELOAD` in the runner wrapper |
| `Invalid file descriptor to ICU data received` | launched via `ld.so` so `/proc/self/exe` ≠ headless_shell | native exec via patchelf'd interpreter |
| `FATAL: crypto/nss_util.cc` on navigation | NSS needs `libsqlite3.so.0` | `libsqlite-glibc` |
| `FATAL: SkFontMgr_FontConfigInterface ... Not implemented` or **blank white screenshots** | glibc fontconfig can't find its config (bionic `/etc/fonts` has no fonts.conf) | `FONTCONFIG_FILE/PATH` → `$PREFIX/glibc/etc/fonts` + `ttf-dejavu-glibc` |
| `Fontconfig error: Cannot load default config file` | same as above | same as above |
| `--headless --disable-gpu` renders nothing | compositor gets no frames | usually the fontconfig row above; keep `--disable-gpu` but **never** add `--disable-software-rasterizer` (kills the only rasterizer) |
| `MCP: 0/0 servers` after editing mcp.json | config read at startup | `/reload` in pi |
| Browser dies between agent turns | terminal process-group reaping | use `start-cdp.sh` (setsid, detached) — and CDP_READY restarts it automatically on next connect |
| `Permission denied` writing `/tmp` | Termux `/tmp` is not writable for some ops | use `$HOME/.cache` (script already does); keep `--disable-dev-shm-usage` |

## Why headless-shell and not full Chrome

- Full Chrome/Chromium spawns network-service / GPU / crashpad child processes that crash under proot (`Network service crashed or was terminated` loop) and OOM low-RAM boxes.
- Chrome for Testing has **no linux-arm64** builds; Google Chrome stable is x86_64-only for Linux. (Termux's bionic `chromium` package exists but drags in gtk3/mesa/pipewire and OOMs.)
- headless-shell is the lean headless-only binary Playwright ships for exactly this: fewer child processes, low RSS, no crashpad, binds CDP in ~1s.
- `--no-sandbox --disable-setuid-sandbox` are required (Termux can't create user namespaces); `--disable-gpu --disable-dev-shm-usage` avoid GPU/shm issues in containers.

## Reference

- Scripts bundled in this skill: `scripts/setup-chrome-mcp.sh` (self-contained idempotent installer), `scripts/start-cdp.sh` (idempotent CDP launcher), `scripts/cdp-lifecycle.sh` (ties Chrome's lifetime to the MCP server's — start on demand, teardown on exit).
- Chrome DevTools MCP: https://github.com/ChromeDevTools/chrome-devtools-mcp
- pi-mcp-adapter (config, `!command` env, `/reload`): https://www.npmjs.com/package/pi-mcp-adapter
- Playwright browser downloads (arm64 builds exist for all browsers): https://playwright.dev/docs/browsers
- Termux glibc repo (`glibc-repo`, `glibc-runner`, `*-glibc` packages): https://github.com/termux-pacman/glibc-packages
