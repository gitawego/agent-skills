---
name: image-sprites-creator
description: >
  Turn a sprite sheet (PNG or JPG) into a production-ready Phaser 3 atlas.
  Use this skill whenever the user has a sprite sheet image and wants to
  extract individual character frames, build a game-ready atlas, split a sheet
  into PNGs, remove a checkered or solid background, or says things like
  "extract frames from this sprite sheet" / "make a Phaser atlas" / "split
  this sheet into individual sprites" / "turn my character sheet into a game
  atlas" / "this sheet has a label cell I want to skip" / "make my sprites
  smaller / pixel-art size". Handles the full pipeline: cell-aware cropping →
  background removal (neural matting for tricky backgrounds, chroma key for
  solid colors) → square-centering with bottom-anchored feet → packing into
  atlas.png + Phaser 3 atlas.json. Includes a bundled sample sheet for
  self-testing. Validates grid dimensions and cell bounds so a misclicked
  --cols can't silently produce garbage frames; auto-fits the atlas canvas
  size; supports --map-file for large cell maps and --resize for shrinking
  big source sprites.
---

# Image Sprites Creator

## What this skill produces

Given one sprite sheet image (PNG/JPG), produces a complete game atlas:

- `tmp/sprites_raw/{key}.png` — raw 1:1 crops of each cell
- `tmp/sprites/{key}.png` — clean transparent frames (default 256×256)
- `atlas.png` + `atlas.json` — final packed atlas (Phaser 3 Multi-Atlas format)

The atlas is ready to load with `this.load.atlas('name', 'atlas.png', 'atlas.json')` in Phaser 3, and works in Phaser 4 and Love2D with minor adapter changes.

## Two modes of operation

### Mode A — Mapped (default, most reliable)

The user provides an explicit list of cell rectangles. The script crops each one as-is. This is the safest path for any sheet that has a non-uniform layout (label cells, mixed cell sizes, irregular grids). Use `--map-file` for large maps (>10 cells) to avoid quoting a huge JSON on the command line:

```bash
node scripts/extract-cells.mjs --source sheet.png --out tmp/raw --map-file cells.json
```

### Mode B — Grid (auto-detect, best effort)

The user provides a row × col count. The script divides the source into equal-sized cells starting at (0, 0). Frame keys are auto-named `{prefix}_{index}` left-to-right, top-to-bottom. Works for any evenly-sized grid.

**Grid validation**: if `--cols` × `--rows` doesn't evenly divide the source (within 1 px), the script refuses to run and prints the nearest valid (cols, rows). This prevents silently producing off-by-a-few-pixels garbage frames.

If the source has irregular cells (e.g. label cells next to character cells), Mode B will misalign. Switch to Mode A.

## Quick start

```bash
# Mode A (mapped) — the user provides exact cell rectangles:
node scripts/extract-cells.mjs \
  --source ./my-sheet.png \
  --out tmp/sprites_raw \
  --map '[{"key":"idle_00","x":0,"y":0,"w":200,"h":200}, ...]'

# Mode A with a JSON file (better for large maps):
node scripts/extract-cells.mjs \
  --source ./my-sheet.png \
  --out tmp/sprites_raw \
  --map-file ./cells.json

# Mode B (grid) — auto-divide into N x M cells:
node scripts/extract-cells.mjs \
  --source ./my-sheet.png \
  --out tmp/sprites_raw \
  --mode grid --cols 3 --rows 2 --prefix frame \
  --animations 'idle:0|walk:1|run:2|jump:3|attack:4|hurt:5'

# Optional: shrink source cells (e.g. 1024x1024 → 256x256) before bg-removal
node scripts/extract-cells.mjs ... --resize 256

# Step 2 — remove background, square-center, resize to 256x256
python3 scripts/remove-bg.py tmp/sprites_raw tmp/sprites

# Optional: produce retro / smaller frames
python3 scripts/remove-bg.py tmp/sprites_raw tmp/sprites --frame-size 128

# Step 3 — pack into atlas + write Phaser 3 JSON (auto-fits canvas size)
node scripts/build-atlas.mjs \
  --in tmp/sprites \
  --out public/assets/atlas \
  --animations-json tmp/sprites_raw/animations.json
```

A `--map` value is a JSON array. Each entry has `key` (frame name, e.g. `idle_00`), `x`, `y`, `w`, `h` in source pixel coordinates. The key is the frame's filename in the atlas.

The `--animations` value in grid mode is a `|`-separated list of `name:idx,idx,idx` triples that maps animation names to the frame indices they contain. It also writes a `animations.json` file you can pass to `build-atlas.mjs` via `--animations-json`.

## Background removal — three methods, auto-selected

`remove-bg.py` picks the best method by inspecting the source:

| Source background | Method used | Notes |
|---|---|---|
| Solid white / near-white | chroma key (white) | Fast, no model needed |
| Solid green / near-green | chroma key (green) | Standard "green screen" workflow |
| Any other solid color (low variance on edges) | chroma key (auto color) | Detects the dominant edge color |
| Checkered / photographic / mixed | rembg (U²-Net) | Best for hand-drawn art, ~170MB model on first run |

Override with `--method rembg|chroma|none`. Pass `--chroma "#00ff00"` to force a specific key color.

**Bottom-anchoring is the default.** Character feet stay on the same baseline across walk/run/jump frames so the animation doesn't bounce. Pass `--top-anchor` for items / icons / symmetric objects that should be bbox-centered.

The rembg model loads once and reuses across all frames (one session, not per-frame), so a 32-frame sheet takes ~5–10s total on CPU after the first run.

## Output format

`atlas.json` is Phaser 3 Multi-Atlas format. Schema:

```json
{
  "frames": {
    "idle_00": {
      "frame": { "x": 0, "y": 0, "w": 256, "h": 256 },
      "rotated": false,
      "trimmed": false,
      "sourceSize": { "w": 256, "h": 256 },
      "spriteSourceSize": { "x": 0, "y": 0, "w": 256, "h": 256 }
    }
  },
  "meta": {
    "image": "atlas.png",
    "size": { "w": 1536, "h": 256 },
    "scale": "1",
    "format": "RGBA8888"
  },
  "animations": [
    { "key": "idle", "frames": [{ "key": "idle_00" }], "frameRate": 6, "repeat": -1 }
  ]
}
```

Default frame size is 256×256. Override with `--frame-size` (or pass `--frame-size 128` to `remove-bg.py` for retro pixel-art). Atlas columns are **auto-fit** by default — the script picks the smallest `cols` that packs all frames into a roughly-square canvas (no wasted pixels). Pass `--atlas-fill` to force the requested `--cols` width even if it leaves empty cells, or `--cols N` to set a different preferred width.

## Input validation

The skill fails loudly (single-line `✗ ...` message, exit code 1) when it detects:

- **Out-of-bounds cell** in `--map`: `✗ cell "oob" extends past image right edge: x+w=400 > width=256`
- **Duplicate keys** in `--map`: `✗ duplicate key "a" — entries [0] and [3] both use it`
- **Un-divisible grid**: `✗ --cols 7 × --rows 3 doesn't divide 768×512 cleanly (leftover 5×2px). Nearest valid: --cols 6 --rows 2.`
- **Grid larger than source**: `✗ Grid too large for source: 6×2 cells would be 166×128px. Source is 1000×256.`
- **Missing input dir**: `✗ Input directory does not exist: /tmp/x`
- **Bad JSON in `--animations-json`**: `✗ --animations-json is not valid JSON: Unexpected token...`

Pass `--verbose` on any script to get the full stack trace if you need to debug an internal failure.

## Self-test with the bundled sample sheet

The skill ships with `assets/sample-spritesheet.png` — a 3×2 grid of distinct shapes (yellow circle, blue triangle, red diamond, green pentagon, purple star, orange square) on a gray checkered background. Run the full pipeline on it to verify everything works end-to-end:

```bash
cd /path/to/skill
mkdir -p tmp && \
  node scripts/extract-cells.mjs \
    --source assets/sample-spritesheet.png \
    --out tmp/sprites_raw \
    --mode grid --cols 3 --rows 2 --prefix frame \
    --animations 'idle:0|walk:1|run:2|jump:3|attack:4|hurt:5' && \
  python3 scripts/remove-bg.py tmp/sprites_raw tmp/sprites && \
  node scripts/build-atlas.mjs \
    --in tmp/sprites \
    --out tmp/out \
    --animations-json tmp/sprites_raw/animations.json
```

Expected output: 6 transparent 256×256 PNGs in `tmp/sprites/`, plus `atlas.png` (1536×256 — auto-fit chose 6 cols) and `atlas.json` with 6 frames and 6 animations.

## Dependencies

The user must install these somewhere Node and Python can find them. The skill scripts do **not** ship with `node_modules` — the scripts use `import` resolution that starts from the script's own directory, so they need `node_modules` resolvable from `scripts/`.

**Recommended setup**: clone the skill into your project (or copy `scripts/` into it) and install deps in your project root:

```bash
# Option 1: clone into your project
git clone <skill-repo> tools/image-sprites-creator
cd tools/image-sprites-creator && npm install sharp canvas
# Now you can run scripts/extract-cells.mjs from any cwd — the skill's
# own node_modules is in tools/image-sprites-creator/node_modules.

# Option 2: copy scripts into your project
cp -r tools/image-sprites-creator/scripts ./sprites-tools
cd . && npm install sharp canvas
node sprites-tools/extract-cells.mjs --source ...

# Option 3: symlink — fastest for testing
ln -s /path/to/your/project/node_modules tools/image-sprites-creator/node_modules
```

**Python dep** (only needed for non-solid backgrounds):

```bash
python3 -m pip install --user "rembg[cpu]" onnxruntime
```

`rembg` is the only "heavy" dep (~170MB model cached in `~/.u2net/` after first run). Everything else is small.

## All flags

### `extract-cells.mjs`

| Flag | Default | Notes |
|---|---|---|
| `--source <path>` | required | PNG or JPG sprite sheet |
| `--out <dir>` | required | Where to write cropped frames |
| `--mode mapped\|grid` | mapped | `mapped` reads `--map`/`--map-file`; `grid` auto-divides into `--cols × --rows` |
| `--map <json>` | — | Inline JSON array of `{key,x,y,w,h}` |
| `--map-file <path>` | — | Read the cell map from a JSON file (better for large maps) |
| `--cols N` (grid mode) | — | Number of columns |
| `--rows N` (grid mode) | — | Number of rows |
| `--prefix <str>` (grid mode) | `frame` | Frame key prefix |
| `--inset N` | 0 | Drop N px from each side of every cell |
| `--resize N` | — | Resize each cropped cell to N×N before saving |
| `--animations <list>` (grid mode) | — | `name:idx,idx\|...` |
| `--animations-out <path>` | `<out>/animations.json` | Override the animations file location |
| `--verbose` | off | Print full stack traces on failure |

### `remove-bg.py`

| Flag | Default | Notes |
|---|---|---|
| `input` dir | required | Raw cropped frames |
| `output` dir | required | Clean frames |
| `--method auto\|rembg\|chroma\|none` | auto | Auto picks chroma/rembg per source |
| `--chroma "#hex"` | — | Force a chroma key color (overrides auto-detect) |
| `--top-anchor` | off | Center-crop instead of bottom-anchored |
| `--first-key <name>` | — | Force method for the very first frame only |
| `--frame-size N` | 256 | Output frame size |
| `--pad N` | 0 | Extra transparent padding |
| `--per-frame` | off | Auto-detect method per-frame instead of once for all |

### `build-atlas.mjs`

| Flag | Default | Notes |
|---|---|---|
| `--in <dir>` | required | Clean frames directory |
| `--out <dir>` | required | Where to write `atlas.png` + `atlas.json` |
| `--frame-size N` | 256 | Per-frame size in atlas.json |
| `--cols N` | 8 | Preferred column count (auto-fit by default) |
| `--atlas-fill` | off | Force the requested `--cols` even if it wastes canvas |
| `--animations-json <path>` | — | JSON with `{animations: [{key, frames, frameRate, repeat}]}` |
| `--animations <list>` | — | Inline `name:idx,idx\|...` |
| `--verbose` | off | Print full stack traces on failure |

## Common pitfalls

- **Mode B with irregular cells**: if the source has label cells or non-uniform sizes, the auto-grid will misalign. Switch to Mode A with explicit rectangles.
- **rembg first run is slow**: the model download takes 10–30s. Subsequent runs reuse the cached model.
- **Bottom-anchor assumption**: the skill assumes the character stands on the bottom edge of each cell. If the source has the character floating in the middle, the output will look wrong. Either crop differently or use `--top-anchor`.
- **Phaser expects exact key names**: animation `frames` in `atlas.json` must match the `key` field in each `frames` entry. Mismatches silently fail (the animation "exists" but plays the wrong frame).
- **Atlas dimensions**: with auto-fit enabled, a 6-frame atlas is 1536×256 (6 cols), a 32-frame atlas is 2048×1024 (8 cols, the upper edge for older WebGL). Pass `--atlas-fill --cols 16` for very small atlases, or `--frame-size 128` for a half-resolution retro atlas.

## Things to confirm with the user

1. **Mapped vs grid mode** — ask if the source has irregular cells (label cells, mixed sizes). When in doubt, default to mapped.
2. **Frame size** — 256 is a good default for HD screens (1.5x at 384px tall). Use 128 for mobile/retro, 512 for very high DPI.
3. **Background type** — most hand-drawn art is on a checkered or photographic background, which means rembg will be used. If the user has a clean green/white background, chroma key is ~10x faster and produces crisper edges. If you pass `--chroma "#hex"`, that overrides auto-detection.
4. **Animation frame order** — frame indices in `--animations` go left-to-right, top-to-bottom in grid mode. The user may want a specific order (e.g. walk cycle should peak in the middle); verify the output and adjust.
5. **Large cell maps** — if the user has more than ~10 cells to specify, ask whether they'd rather pass `--map-file <path>` than inline `--map` on the command line.
6. **Source resolution** — if source cells are much larger than the final frame size (e.g. 1024×1024 source → 256×256 final), suggest `--resize N` at extract time so background removal runs on the smaller image (faster, cleaner edges).

## What the skill does NOT do

- No Aseprite (.aseprite) file support — convert with `aseprite -b file.aseprite file.png` first if needed.
- No sprite-sheet auto-detection of irregular cell sizes (irregular cells → use Mode A with measured coordinates).
- No sprite trimming (every frame is the full cell size). If the user needs trimmed sprites, edit the atlas JSON after the fact or pre-crop the source.
- No mipmaps or texture-packing optimization (basic grid pack only).
- No Phaser / engine integration code (atlas loading, animation registration) — the skill produces the assets; engine glue is the user's job.
