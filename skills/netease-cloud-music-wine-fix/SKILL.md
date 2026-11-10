---
name: netease-cloud-music-wine-fix
description: Fix NetEase Cloud Music (网易云音乐) running under Wine/Lutris on Linux when album covers, playlist art, 每日推荐 thumbnails or sidebar covers render as grey or blank placeholders while text and layout stay fine. Use this skill whenever someone reports blank/grey cover art, "封面不显示", "图片全没了", covers that come back after a wipe and vanish again on the next restart, or asks how to make that fix permanent. Also use it to install or remove the automatic pre-launch cleanup hook, and to tell apart this cache-state bug from a real network or GPU failure in a Wine-wrapped CEF client.
---

# NetEase Cloud Music: covers missing under Wine

## What the failure looks like

The UI is fully usable — navigation, text, song lists, playback — but image slots are flat grey rounded rectangles: 每日推荐 row thumbnails, 推荐歌单 tiles, sidebar playlist covers, 精选活动 banners.

Tell-tale details that distinguish it from a network problem:

- Text, layout, fonts and hover states all render.
- Some images *do* render: your avatar, the now-playing cover, and older promo banners whose bytes are already on disk.
- The first launch after wiping local state looks **perfect**. The next restart goes grey again. That "works once, then not" shape is the signature.

## Why it happens

The client renders its entire UI inside CEF (Chromium), loaded from a custom scheme:

```
orpheus://orpheus/pub/app.html
```

Covers are **not** loaded as plain URLs. Each one is rewritten into the client's own cache proxy:

```
orpheus://cache/?http://p3.music.126.net/<id>/<file>.jpg?param=140y140
```

That scheme is handled by NetEase's native code, which fetches the image, stores it in its own on-disk cache, and hands the bytes to the renderer. Under Wine, cache/state written by session N is not reliably readable by session N+1, so a later launch fails the lookup and the renderer paints the placeholder.

You can confirm the diagnosis from the app's own stderr (run it from a terminal or read Lutris's log):

```
ERROR:https_strategy.cc(123)] Not find the url request id 147.     ← once per image
ERROR:client_app.cpp(253)] CustomSchems Add Failed, it may called localstorage or cache access failed(1).
```

Because the trigger is *stale state from the previous session*, every "just clear the cache" remedy appears to work and then silently regresses on the next start. That is why the durable fix is not a bigger cache wipe — it is making every launch start clean.

## The fix

```bash
python3 scripts/install-lutris-hook.py
```

That does three things:

1. Copies `scripts/clear-client-state.sh` to `~/.local/bin/netease-clear-cache` (a stable path, so the hook keeps working if this skill folder moves).
2. Finds the Lutris game YAML for NetEase Cloud Music — scoring candidates so the installed game wins over its leftover installer recipe.
3. Adds `system: prelaunch_command` + `prelaunch_wait: true`, which Lutris runs and waits for before every launch. Lutris logs `Prelauch command: ...` in its log when it fires.

It backs up the YAML first, is idempotent, and refuses to clobber an existing unrelated `prelaunch_command` without `--force`.

Revert with:

```bash
python3 scripts/install-lutris-hook.py --remove
```

For a launch that bypasses Lutris, clear manually and restart:

```bash
scripts/fix-images.sh
```

Both scripts discover the Wine prefix (via `WINEPREFIX`, `NETEASE_PREFIX`, or by scanning common prefix locations), so they are not tied to one machine's layout. `clear-client-state.sh --dry-run` shows what it would delete.

## Traps that cost real time

**Clear the state files together with the cache.** Removing `Cache` while leaving `webdata`, `dumps`, `localdata`, `localware` or `info` in place makes the client open, paint correct covers, then exit roughly every 20 seconds: the native state still references tracks and images whose cache is gone. The script clears them as a set for this reason.

**Never delete `webapp*/Cookies`.** Login lives there. Clearing only the profile's `Cache`/`GPUCache`/`Code Cache` keeps the session logged in.

**Do not hardcode the CEF profile directory name.** It is named after the bundled Chromium major (`webapp91` today). A client update shipping newer CEF renames it, so glob `webapp*/`.

**Expect one "网易云音乐崩溃了" dialog** on the first start after a state reset. Dismiss it and start again; it is not a sign the fix failed.

**Do not `pkill -f cloudmusic` from an inline shell whose own command line contains that string** — `pkill -f` will match the shell itself and kill your session mid-script. Use `pkill -x cloudmusic.exe`.

## Verify it worked

Screenshot the real window and look at it — do not trust "no errors in the log":

```bash
spectacle -b -n -a -o /tmp/cover-check.png   # KDE; -a = active window
```

Crop a known cover region and zoom if the difference is subtle. Confirm the client is still logged in (avatar/username, or `webapp*/Cookies` modified recently), then restart once more and check again — surviving a **restart** is the actual pass condition, since a single clean launch is what the broken state also produces.

## Not this problem

Distinguish before prescribing anything:

| Symptom | Real cause | Where to look |
|---|---|---|
| Covers grey, text fine, works once after a wipe | stale state from the previous session | this skill |
| `fetch()` inside the app fails, or curl fails | network/DNS/firewall | test the URL from the shell first |
| Constant crashes, `GPU: ""` in the client's `dumps/appParam`, `egl: failed to create dri2 screen` | broken GPU path (WineD3D over a GL driver that cannot drive the dGPU) | `wine: dxvk` in the Lutris YAML, GPU driver selection |

Two popular wrong answers worth rejecting explicitly:

- **IPv6.** Folklore from Wine QQ/TIM image bugs. Verify instead of trusting: this class of bug persists on hosts with no IPv6 address and no IPv6 default route, and the app's own `fetch()` to the cover CDN succeeds while `<img>` fails. Changing `net.ipv6.conf.*.disable_ipv6` is not the fix.
- **"The cache is full."** Cache *content* is not the trigger — an empty cache does not prevent the regression, and an enormous one does not cause it.

## After a client update

Updates are full installers staged in `%LOCALAPPDATA%\NetEase\CloudMusic\update\orpheus_install.exe` and run inside the prefix; they replace `Program Files (x86)\NetEase\CloudMusic` and re-register the `orpheus://` protocol. The hook itself lives outside the prefix and survives.

What can change underneath you:

- **CEF profile directory renames** (handled by the `webapp*` glob).
- **`cloudmusic.exe` moved/renamed** → Lutris cannot find the executable; fix `game.exe` in the game YAML.
- **The updater relaunching the app from inside Wine** bypasses the Lutris hook, so that one start may show grey covers until the next Lutris launch.
- **A forced update that misbehaves under Wine.** If the app stops starting or crashes constantly, a rollback copy of the previous install directory makes recovery a `mv` instead of a reinstall.

## Bundled files

- `scripts/clear-client-state.sh` — the cleanup itself; `--dry-run` and `--data-dir` supported.
- `scripts/install-lutris-hook.py` — install/remove the hook; `--game`, `--bin-dir`, `--dry-run`, `--force`.
- `scripts/fix-images.sh` — quit, clear, relaunch (manual form).
- `references/diagnosis.md` — evidence-gathering playbook for when the symptom does not match, including how to read the live DOM.
