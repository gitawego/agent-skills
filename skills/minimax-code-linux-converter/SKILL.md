---
name: minimax-code-linux-converter
description: Convert the proprietary MiniMax Code macOS DMG into a portable Linux x64 Electron build. Use this skill whenever the user asks to convert, port, reverse-engineer for personal interoperability, build, package, or run MiniMax Code on Linux from a MiniMax Code .dmg or from a MiniMax Code version number. This skill is especially relevant for prompts mentioning MiniMax Code, minimax-agent-prod release DMGs, SSO redirect failures, “服务启动失败”, Electron DMG-to-Linux conversion, or building a non-installed portable folder. The bundled script performs the deterministic conversion; prefer invoking it instead of recreating the steps manually.
---

# MiniMax Code Linux Converter

Convert a MiniMax Code macOS `.dmg` into a portable Linux x64 directory. The skill bundles the conversion script at:

```bash
scripts/convert-minimax-code-dmg-to-linux.sh
```

The script is self-contained for the conversion workflow: it downloads/extracts the macOS DMG, downloads Linux Electron, assembles the Linux app layout, copies the bundled daemon resources, rebuilds `better-sqlite3` for Electron's ABI, and replaces the bundled macOS `opencode` binary with a Linux `opencode` if one is available. It can also install/register the app, but only when explicitly requested.

## Safety and scope

Use this for the user's own local interoperability/testing. Do not help redistribute proprietary MiniMax assets. By default, the script builds in the requested working directory and does **not** install desktop entries, register URL handlers, or modify `~/.local/bin`.

Installing/registering is an outward-facing local system change because it writes `~/.local/opt`, `~/.local/bin`, `~/.local/share/applications`, and URL-scheme associations. After a successful portable build, ask whether the user wants to install it. Only run install mode after the user says yes (or if their original prompt already explicitly asked to install).

## Inputs to collect

Identify one of these inputs from the user's prompt:

- Existing DMG path, e.g. `/home/hlu/Downloads/MiniMax Code-3.0.46.dmg`
- Version number, e.g. `3.0.46`, for downloading:
  `https://filecdn.minimax.chat/public/minimax-agent-prod/release/MiniMax%20Code-{version}.dmg`

Optional inputs:

- Output directory. If omitted, use `./MiniMax-Code-linux-{version}` in the current working directory.
- Linux `opencode` binary path. If omitted, the script auto-detects `opencode` from `PATH` or `~/.opencode/bin/opencode`.
- Electron version. Default is `38.3.0`, matching MiniMax Code 3.0.46. Only override if the user explicitly asks or the app bundle clearly uses a different Electron version.

## Workflow

1. Resolve this skill's directory and script path.
2. Run the bundled script from the directory where the user wants the output folder created.
3. Pass `--dmg` if the user supplied a DMG path; otherwise pass `--version`.
4. Pass `--out` only if the user requested a specific output directory.
5. If the user already explicitly asked to install/register, pass `--install` (and `--replace-install` only after they confirm replacing an existing install is OK).
6. Otherwise, after the portable build succeeds, ask: “Do you want me to install/register this build so it appears in your app launcher and SSO redirects work?”
7. Report the exact output folder, run command, and any caveats from the script output.

### Command templates

Existing DMG:

```bash
SKILL_DIR="<absolute path to minimax-code-linux-converter>"
cd "<desired build cwd>"
bash "$SKILL_DIR/scripts/convert-minimax-code-dmg-to-linux.sh" \
  --dmg "/path/to/MiniMax Code-3.0.46.dmg"
```

Download by version:

```bash
SKILL_DIR="<absolute path to minimax-code-linux-converter>"
cd "<desired build cwd>"
bash "$SKILL_DIR/scripts/convert-minimax-code-dmg-to-linux.sh" \
  --version "3.0.46"
```

Specific output directory:

```bash
bash "$SKILL_DIR/scripts/convert-minimax-code-dmg-to-linux.sh" \
  --dmg "/path/to/MiniMax Code-3.0.46.dmg" \
  --out "./MiniMax-Code-linux-3.0.46"
```

Use an explicit Linux `opencode` binary:

```bash
bash "$SKILL_DIR/scripts/convert-minimax-code-dmg-to-linux.sh" \
  --version "3.0.46" \
  --opencode "$HOME/.opencode/bin/opencode"
```

Install/register in the same run, only after the user asks for installation:

```bash
bash "$SKILL_DIR/scripts/convert-minimax-code-dmg-to-linux.sh" \
  --dmg "/path/to/MiniMax Code-3.0.46.dmg" \
  --install
```

Replace an existing install only after explicit confirmation:

```bash
bash "$SKILL_DIR/scripts/convert-minimax-code-dmg-to-linux.sh" \
  --dmg "/path/to/MiniMax Code-3.0.46.dmg" \
  --install \
  --replace-install
```

Install mode writes:

- `~/.local/opt/minimax-code-{version}` (or `--install-dir`)
- `~/.local/bin/minimax-code` symlink
- `~/.local/share/applications/minimax-code.desktop`
- `xdg-mime` handlers for `minimax-cn`, `minimax`, and test/staging variants

## Dependencies

Before running, expect the host to have:

- `7z`
- `curl`
- `unzip`
- `node`, `npm`, `npx`
- `file`, `find`, `grep`, `sed`, `tar`
- native build tools: `make`, `g++`, `python3`

The script checks these and fails early with a clear missing-command error. If a dependency is missing, tell the user what to install for their distro rather than editing the script.

## Interpreting results

A successful run prints:

```text
Build complete:
  <output-dir>

Run:
  "<output-dir>/run-minimax-code"
```

It also performs final verification that:

- `minimax-code` is a Linux ELF executable.
- `better-sqlite3.node` is a Linux ELF shared object rebuilt for Electron.
- bundled `opencode` is Linux ELF if a Linux `opencode` was available.

If `opencode` is missing, the converted desktop app and daemon may still launch, but coding-agent execution can fail. Tell the user to install `opencode` or rerun with `--opencode /path/to/opencode`.

## Post-build install prompt

After a successful portable build, ask the user whether to install/register it:

> The portable build is ready at `<output-dir>`. Do you want me to install/register it so it appears in your app launcher and SSO browser redirects work?

If they say **yes**, run the bundled script again with the same `--dmg` or `--version`, the same output choices if needed, and `--install`. If an install directory already exists and the script refuses to overwrite it, ask whether to replace it; only then rerun with `--replace-install`.

If they say **no**, stop after reporting the portable run command:

```bash
"<output-dir>/run-minimax-code"
```

The script also writes a desktop template at `<output-dir>/minimax-code.desktop` for manual registration.

## Known caveats

The conversion fixes the core Electron shell, bundled daemon, `better-sqlite3`, and `opencode`. Some optional macOS-native modules may remain and can affect specific features:

- `node-screenshots-darwin-*` can affect screenshot/screen-observer features.
- `node-pty` may need Linux prebuilds for integrated terminal features.
- macOS-only permission modules may remain in `node_modules` but are usually platform-gated.

If the user reports feature-specific failures after the build, diagnose logs first; do not assume the whole conversion failed.
