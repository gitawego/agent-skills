---
name: image-sprites-creator
description: >
  Turn a hand-drawn (or generated) sprite sheet into a production-ready Phaser
  3 atlas. Use this skill whenever the user has a sprite sheet image and wants
  to extract individual character frames, build a game-ready atlas, split a
  sheet into PNGs, remove a checkered or solid background, or says things like
  "extract frames from this sprite sheet" / "make a Phaser atlas" / "split
  this sheet into individual sprites" / "turn my character sheet into a game
  atlas". Handles the full pipeline: cell-aware cropping → background removal
  (neural matting for tricky backgrounds, chroma key for solid colors) →
  square-centering with bottom-anchored feet → packing into atlas.png + Phaser
  3 atlas.json. Includes a bundled sample sheet for self-testing.
---

# Image Sprites Creator

## What this skill produces

Given one sprite sheet image (PNG/JPG), produces a complete game atlas:

- `tmp/sprites_raw/{key}.png` — raw 1:1 crops of each cell
- `tmp/sprites/{key}.png` — clean 256×256 transparent frames
- `atlas.png` + `atlas.json` — final packed atlas (Phaser 3 Multi-Atlas format)

The atlas is ready to load with `this.load.atlas('name', 'atlas.png', 'atlas.json')` in Phaser 3, and works in Phaser 4 and Love2D with minor adapter changes.

## Two modes of operation

### Mode A — Mapped (default, most reliable)

The user provides an explicit list of cell rectangles. The script crops each one as-is. This is the safest path for any sheet that has a non-uniform layout (label cells, mixed cell sizes, irregular grids).

### Mode B — Grid (auto-detect, best effort)

The user provides a row × col count. The script divides the source into equal-sized cells starting at (0, 0). Frame keys are auto-named `{prefix}_{index}` left-to-right, top-to-bottom. Works for any evenly-sized grid (the bundled sample sheet uses this mode).

If the source has irregular cells (e.g. label cells next to character cells), Mode B will misalign. Switch to Mode A.

## Quick start

```bash
# Mode A (mapped) — the user provides exact cell rectangles:
node scripts/extract-cells.mjs \
  --source ./my-sheet.png \
  --out tmp/sprites_raw \
  --map '[{"key":"idle_00","x":0,"y":0,"w":200,"h":200}, ...]'

# Mode B (grid) — auto-divide into N x M cells:
node scripts/extract-cells.mjs \
  --source ./my-sheet.png \
  --out tmp/sprites_raw \
  --mode grid --cols 3 --rows 2 --prefix frame \
  --animations 'idle:0|walk:1|run:2|jump:3|attack:4|hurt:5'

# Step 2 — remove background, square-center, resize to 256x256
python3 scripts/remove-bg.py tmp/sprites_raw tmp/sprites

# Step 3 — pack into atlas + write Phaser 3 JSON
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
    "size": { "w": 2048, "h": 1024 },
    "scale": "1",
    "format": "RGBA8888"
  },
  "animations": [
    { "key": "idle", "frames": [{ "key": "idle_00" }], "frameRate": 6, "repeat": -1 }
  ]
}
```

Default frame size is 256×256. Override with `--frame-size`. Default atlas layout is 8 columns; override with `--cols`. Frame count determines row count automatically.

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

Expected output: 6 transparent 256×256 PNGs in `tmp/sprites/`, plus `atlas.png` (1536×512) and `atlas.json` with 6 frames and 6 animations.

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

## Common pitfalls

- **Mode B with irregular cells**: if the source has label cells or non-uniform sizes, the auto-grid will misalign. Switch to Mode A with explicit rectangles.
- **rembg first run is slow**: the model download takes 10–30s. Subsequent runs reuse the cached model.
- **Bottom-anchor assumption**: the skill assumes the character stands on the bottom edge of each cell. If the source has the character floating in the middle, the output will look wrong. Either crop differently or use `--top-anchor`.
- **Phaser expects exact key names**: animation `frames` in `atlas.json` must match the `key` field in each `frames` entry. Mismatches silently fail (the animation "exists" but plays the wrong frame).
- **Atlas dimensions**: with 32 frames at 256×256 in 8 columns, the atlas is 2048×1024. If the user's engine has a texture-size limit (older WebGL = 2048), this is the edge. Reduce `--frame-size` to 128 or increase `--cols` to 16.

## Things to confirm with the user

1. **Mapped vs grid mode** — ask if the source has irregular cells (label cells, mixed sizes). When in doubt, default to mapped.
2. **Frame size** — 256 is a good default for HD screens (1.5x at 384px tall). Use 128 for mobile/retro, 512 for very high DPI.
3. **Background type** — most hand-drawn art is on a checkered or photographic background, which means rembg will be used. If the user has a clean green/white background, chroma key is ~10x faster and produces crisper edges.
4. **Animation frame order** — frame indices in `--animations` go left-to-right, top-to-bottom in grid mode. The user may want a specific order (e.g. walk cycle should peak in the middle); verify the output and adjust.

## What the skill does NOT do

- No Aseprite (.aseprite) file support — convert with `aseprite -b file.aseprite file.png` first if needed.
- No sprite-sheet auto-detection of irregular cell sizes (irregular cells → use Mode A with measured coordinates).
- No sprite trimming (every frame is the full cell size). If the user needs trimmed sprites, edit the atlas JSON after the fact or pre-crop the source.
- No mipmaps or texture-packing optimization (basic grid pack only).
- No Phaser / engine integration code (atlas loading, animation registration) — the skill produces the assets; engine glue is the user's job.
