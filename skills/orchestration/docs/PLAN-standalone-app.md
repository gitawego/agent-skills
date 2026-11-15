# Plan: standalone Tauri app

Design: [ADR-005](ADR-005-standalone-tauri-app.md).

## Repository layout

The app is a separate repository. This skill remains the source of the engine,
UI and agent contract. The app pins a skill commit.

```text
orchestration-app/
  package.json                  # app build tooling
  bun.lock
  runtime.json                  # pinned Bun versions, URLs, SHA-256
  vendor/
    orchestration/              # pinned copy/submodule of this skill
    pi/                         # pinned pi release
  ui/                           # app bootstrap + copied skill assets
  src-tauri/
    Cargo.toml
    tauri.conf.json
    capabilities/
    src/
      main.rs
      runtime.rs                # Bun download/verify/launch
      pty.rs                    # portable-pty registry
      ticket.rs                 # HMAC terminal tickets
      tray.rs
  scripts/
    build-ui.mjs
    fetch-runtime.mjs
    check-licenses.mjs
  packaging/
    latest.json
    appimage/
  tests/
```

Build inputs:

- `vendor/orchestration` is read-only at build time; the app does not modify
  the skill.
- `vendor/pi` is a tested pi release, not a system install.
- `runtime.json` pins Bun per platform. v1 has `linux-x64` only.

## Milestone 0 — spikes

Facts before code:

- [x] Run a full campaign under Bun using the existing engine and fake workers:
      work → checks → review → integration → delivery.
- [x] Run a real pi work turn and review turn under Bun, including report
      writing and git commits (`hello-bun2`: mimo work, deepseek review).
- [ ] Create an agy ACP session, capture its transcript, resume it, and check
      whether `agy --conversation <id>` can open the same session.
- [x] Build a Tauri AppImage with a Rust `portable-pty` terminal and verify it
      on the build machine; the AppImage bundles WebKitGTK libraries.
- [x] Download a pinned Bun release, verify its checksum, and run the sidecar
      from app data with no system Bun on `PATH`.

Exit: the fallback decisions are confirmed before the UI is built. If a full
pi campaign fails under Bun, add the Node-for-pi fallback from ADR-005.

## Milestone 1 — app shell and onboarding

- [x] Tauri v2 skeleton with a bundled frontend and a Bun sidecar.
- [x] API base/token injection for the existing panel UI.
- [x] Runtime manager: download, verify, extract and launch pinned Bun.
- [x] Bundle pi and the skill snapshot.
- [ ] First-run flow: git/WebKit check, Bun download, pi login, project picker,
      `orchestrate init`. (Bun setup, project picker/init and the Leader terminal
      exist; explicit git/WebKit checks and a pi login button do not.)
- [x] Tray, explicit Quit, single instance.
- [ ] Sidecar crash detection and restart.

Exit: the app opens a project, runs `orchestrate status`, and shows the Fleet
screen with no system Node, pi or skill on `PATH`.

## Milestone 2 — pi terminal and sessions

- [x] Rust `portable-pty` registry with one PTY per ticket.
- [x] HMAC terminal tickets issued by Bun after lease checks.
- [x] Tauri commands `pty_open`, `pty_write`, `pty_resize`, `pty_close`.
- [x] Events `pty:data`, `pty:exit` (and the UI adapter).
- [x] xterm.js adapter uses Tauri IPC in the app and WebSocket in the browser.
- [ ] Fork, takeover, detach/reattach, hand-back terminate. (Fork and Leader
      terminals verified in the app; takeover/hand-back covered by engine tests.)
- [x] Human-session spend remains recorded.

Exit: a live pi ticket can be forked, taken over, typed into, handed back and
reviewed, with no shell and no arbitrary command path.

## Milestone 3 — agy and Gemini

- [ ] Detect `agy` and its authentication state. (The adapter catalog is shown;
      there is no explicit auth probe or guided install.)
- [ ] Guided install/auth when the user wants Gemini.
- [x] List agy models and bind a Gemini model to a ticket. (CLI path tested; the
      app does not yet expose a picker.)
- [x] Relax the CLI's ACP freeze for an explicit Gemini binding while keeping
      non-Gemini work pi-only.
- [x] ACP client in Bun: `session/new`, `session/prompt`, `session/update`,
      permission handling, session ids. (Existing engine adapter.)
- [x] Sessions UI adapter for agy: transcript, tool cards, steer box. No direct
      ACP permission/stop controls yet.
- [ ] Optional native agy terminal if conversation mapping is verified.
- [x] Gemini ticket end-to-end through work and review (`gemini-bun`:
      agy/gemini work, pi/deepseek review, delivered).

Exit: a Gemini ticket runs through agy, appears in Sessions, can be questioned
or steered, and still passes the normal evidence gates.

## Milestone 4 — lifecycle and state

- [x] Shared registry/state with the CLI; existing projects open unchanged.
- [x] Multiple projects in the app; project switching does not kill sidecars.
- [x] Window close to tray; Quit stops sidecar and PTYs.
- [ ] App restart: PTYs are gone, pi sessions resume; human-owned tickets stay
      parked. (State/lease persists; restart smoke test not complete.)
- [ ] Runtime/pi version display and compatibility check.
- [ ] Logs with redaction; no secrets in app logs.

Exit: the app is a client of the existing state, not a second store.

## Milestone 5 — AppImage and updates

- [x] Tauri AppImage build on Linux x64.
- [ ] Signed updater artifacts and `latest.json`.
- [x] Runtime manifest for Bun; pi version compatibility check is still open.
- [ ] First-run desktop-entry integration, optional.
- [ ] FUSE/WebKitGTK checks and documented fallbacks. (AppImage bundles WebKitGTK;
      runtime `--appimage-extract-and-run` is documented.)
- [ ] CI builds AppImage on a clean runner and publishes a release.
- [ ] Update and rollback test from the previous version.

Exit: an AppImage installs, updates, and rolls back without touching system
Node, pi or the skill.

## Milestone 6 — acceptance

- [ ] Clean Linux x64 VM/container with `git` only.
- [ ] Install the AppImage, complete onboarding, authenticate pi.
- [ ] Create or open a project, plan in the Leader terminal.
- [ ] Run a real campaign with pi workers and a cold review.
- [x] If agy is installed/authenticated, run a Gemini ticket through ACP.
- [x] Approve delivery and clean up (`gemini-bun` merged, cleaned, archived).
- [x] Verify the AppImage size target and first-run download integrity
      (133 MB AppImage; Bun 1.4.4 SHA-256 download; app-managed runtime boot).

Exit: the acceptance script passes without a system Node, npm, pi or skill on
`PATH`.

## Tests

Unit and integration:

- Rust: HMAC ticket verification, PTY argv construction, path validation,
  one-PTY-per-ticket, kill on hand-back.
- Bun: existing 238+ engine tests under Bun; transcript parser; terminal ticket
  issuance; app-mode API.
- ACP: fake ACP server for transcript, permissions, resume and stop.
- Tauri: frontend adapter tests; IPC command validation; updater manifest.
- Packaging: AppImage smoke in a clean container; checksum verification.

Manual:

- full pi campaign under Bun;
- Gemini campaign through agy;
- update/rollback;
- tray/quit and sidecar crash recovery.

## Acceptance criteria

1. A new Linux user with only git can install the AppImage, download Bun, sign
   in to pi, open a project, plan and run a campaign.
2. Pi sessions work through Rust PTY; no `node-pty` in the packaged app.
3. Gemini sessions work through agy ACP when agy is installed/authenticated;
   the app says why when it is not.
4. A hand-back still runs report, review and integration; no gate bypass.
5. Closing the window keeps the supervisor alive; Quit stops it cleanly.
6. The app shares state with the CLI; existing projects open unchanged.
7. The AppImage updates and rolls back with signature verification.
8. No remote listener, no arbitrary PTY command, no shell.

## Out of scope

- team, remote and hosted access;
- mobile, Windows and macOS;
- custom planner chat;
- bundled agy;
- `.deb`, Flathub, Snap, AUR;
- multi-user credentials;
- auto-start at login.
