# Diagnosis playbook

Use this when the symptom does not line up cleanly with "covers grey, everything else fine", or when you want evidence before changing anyone's machine.

## 1. See the actual pixels

Window titles and logs lie; a screenshot does not.

```bash
spectacle -b -n -a -o /tmp/cover-check.png    # KDE: active window
identify /tmp/cover-check.png                 # confirm you captured a window, not the desktop
```

Crop and zoom the cover column if it is ambiguous:

```bash
magick /tmp/cover-check.png -crop 120x120+280+280 +repage -filter point -resize 480x480 /tmp/cover-zoom.png
```

What you are looking for: uniform light-grey rounded rectangles with no broken-image glyph. That is the app's placeholder, meaning the image never satisfied the handler — not a decode error.

Useful separate observation: **which** images survive. Player art, avatar and older promo banners usually render (already on disk), while the freshly recommended tiles do not. That split is the strongest single clue.

## 2. Confirm the image pipeline

Covers do not ride Chromium's network stack; they ride NetEase's `orpheus://cache/?<url>` scheme. Reading the live DOM is the fastest way to see this and to separate "never loaded" from "loaded but not painted".

Attach DevTools by launching the client yourself with the port open:

```bash
WINEPREFIX=/path/to/prefix wine "C:\\Program Files (x86)\\NetEase\\CloudMusic\\cloudmusic.exe" \
  --remote-debugging-port=9222
curl -s http://127.0.0.1:9222/json/version
```

Notes that save time:

- A second instance launched while the client is running usually just forwards to the existing one; the port will not open. Quit first.
- If you omit `WINEPREFIX`, Wine silently falls back to `~/.wine` and fails with `wine: failed to open "C:...cloudmusic.exe"`. That error means wrong prefix, not a broken install.
- A Lutris-launched instance cannot be attached without adding the flag to the game YAML's `game.args` or `system.prelaunch_command` – do that only with the user's agreement.

Then, over the CDP websocket, evaluate:

```js
(() => {
  const imgs = [...document.images];
  return JSON.stringify({
    href: location.href,                       // expect orpheus://orpheus/pub/app.html
    total: imgs.length,
    ok: imgs.filter(i => i.naturalWidth > 0).length,
    broken: imgs.filter(i => i.naturalWidth === 0).length,
    sample: imgs.slice(0, 3).map(i => (i.currentSrc || i.src).slice(0, 100))
  }, null, 1);
})()
```

Read it like this:

- `currentSrc` starts with `orpheus://cache/?` → confirms the native proxy path.
- `naturalWidth === 0` on the grey ones → the handler failed; this is a load failure, not a compositing/paint problem.
- `naturalWidth > 0` while still grey → then it really is a paint/GPU problem; go to the GPU section instead.

You can also prove the network is innocent from inside the app:

```js
fetch('https://p3.music.126.net/<id>/<file>.jpg?param=140y140')
  .then(r => 'status ' + r.status).catch(e => 'ERR ' + e.message)
```

A 200 here while `document.images` shows broken entries is decisive: the host's DNS, TLS and CDN path are fine.

## 3. Prove the network from the shell

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
  'http://p3.music.126.net/<id>/<file>.jpg?param=140y140'
```

The CDN answers `200 image/jpg` and sends `Access-Control-Allow-Origin: *`, so CORS is not a factor. Parallel bursts are also fine (~30 concurrent requests all 200), so "rate limiting" is not a factor either.

## 4. Inspect the on-disk state

```bash
DATA=~/.wine/drive_c/users/*/AppData/Local/NetEase/CloudMusic   # adjust for the real prefix

ls "$DATA"/Cache/Cache | sed 's/.*\.//' | sort | uniq -c        # .uc / .idx / .info triples
ls -d "$DATA"/webapp*                                            # CEF profile dirs
du -sh "$DATA"/Cache "$DATA"/webapp*/Cache
```

A healthy media cache has matched counts. Orphaned `.uc` blobs without their `.idx`/`.info` sidecars (observed 1505 vs 1458, and 102 vs 97 after one short session) indicate the write path is not completing under Wine.

Do not over-read this: orphan counts are corroborating evidence, not the trigger. An **empty** cache still regresses on the next start, which rules out "cache content" as the cause.

## 5. Read the app's own stderr

Launch from a terminal (or read the Lutris log) and filter the noise:

```bash
grep -v -E 'MESA-EGL|pci id for fd' app.log | tail -30
```

Signature lines for this bug:

```
ERROR:https_strategy.cc(123)] Not find the url request id <n>.        (≈ one per image request)
ERROR:client_app.cpp(253)] CustomSchems Add Failed, it may called localstorage or cache access failed(1).
ERROR:HTTPDNS] ... code:28, msg:Timeout was reached                  (overseas paths; noise, not cause)
ERROR:font_util.cpp(126)] Load: 宋体 check failed                     (missing CJK fonts; cosmetic)
```

The HTTPDNS timeouts and the missing-font warnings are real but **independent**: both appear in sessions where every cover renders correctly. Do not chase them when diagnosing grey covers.

## GPU failure mode (different bug)

```
MESA-EGL: pci id for fd NN: 10de:XXXX, driver (null)
MESA-EGL: warning: egl: failed to create dri2 screen
```

plus `"GPU": ""` in `%LOCALAPPDATA%\NetEase\CloudMusic\dumps\appParam`. That is Wine's D3D→OpenGL path failing to get a usable driver for the discrete GPU (often a hybrid Intel+NVIDIA laptop where the EGL vendor is wrong). Its symptoms are crashes and rendering artefacts, not consistently-grey covers with perfect text. Fixing it is a separate change: enable DXVK in the Lutris game YAML (`wine: dxvk: true`) so D3D11 goes over Vulkan, or force software rendering.

## Safety

- Back up anything you delete under the prefix; `Cache`, `webdata`, `dumps`, `localdata`, `localware`, `info` are regenerable, `webapp*/Cookies` is not (it is the login).
- Do not edit Lutris configs without a copy; `install-lutris-hook.py` timestamps its backups.
- When reporting findings, quote only the log lines that carry signal and redact paths/tokens you do not need.
