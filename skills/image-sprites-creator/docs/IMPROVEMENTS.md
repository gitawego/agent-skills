# Skill improvements — gap analysis & plan

This doc captures weaknesses found by stress-testing the skill against the three bundled eval sheets plus adversarial inputs. Each gap is paired with the fix we'll ship.

## Findings (validated by running scripts)

### G1. Grid auto-includes separator pixels (medium)
**Repro**: `irregular-spritesheet.png` (1000×256, 5 cells separated by cyan vertical lines) with `--mode grid --cols 5 --rows 1`. The grid mode computes `cellW = 1000/5 = 200` per cell. The 4 cyan separator lines at x ≈ 200, 400, 600, 800 get absorbed into cell N+1's left edge.
**Fix**: detect background-colored separator runs and shrink cell widths/positions to drop them. Add `--no-trim-gaps` to opt out. Algorithm:
1. Run on a single test row; locate vertical strips where every pixel in the strip is "background-like" (matches the perimeter color).
2. Snap cell boundaries to those strips.

### G2. Grid not divisible → silent data loss (high)
**Repro**: `green-spritesheet.png` (256×256) `--cols 3 --rows 3` → cells 85×85, last col/row silently dropped (`85*3 = 255`, leaves 1px on right + bottom; but if cols=4 → 64*4=256 ok, while cols=7 → 36*7=252 leaving 4px). No warning.
**Fix**: validate `cols` and `rows` evenly divide source `width`/`height` (within 1 px tolerance). On failure, suggest the nearest valid (cols, rows) and abort with `✗ --cols 7 doesn't divide width 256 (7*36=252, 4px leftover)`.

### G3. Grid larger than image → empty frames (high)
**Repro**: `irregular-spritesheet.png` (1000×256) `--cols 6 --rows 2` → produces 12 frames, several 100% transparent/empty. Silently succeeds.
**Fix**: same as G2 — refuse if `cols*cellW > width + 1` or `rows*cellH > height + 1`. Suggest a valid grid.

### G4. Out-of-bounds cell in `--map` (medium)
**Repro**: `--map '[{"key":"a","x":300,"y":0,"w":100,"h":100}]'` on 256×256 → raw `sharp.extract_area: bad extract area` stack trace.
**Fix**: bounds-check each cell against source dimensions in mapped mode. Print `✗ cell "a" extends past image bounds: x+w=400 > width=256`.

### G5. Duplicate keys in `--map` (medium)
**Repro**: two map entries with `key:"a"` → only one `a.png` is written (second overwrites first).
**Fix**: detect duplicates and fail with `✗ duplicate key "a" at index 1`.

### G6. Inline JSON awkward for big maps (low UX)
**Fix**: add `--map-file <path>` to read the JSON array from a file. Keep `--map` for tiny inline cases.

### G7. Leaked stack traces (low UX)
**Repro**: any crash → 5+ lines of node_modules internals.
**Fix**: top-level error handler hides trace; print `✗ <message>`. Add `--verbose` to opt back into full trace. Don't import from `node_modules` paths in messages.

### G8. Auto chroma uses only frame 0 (medium)
**Repro**: a sheet where frame 0 is fully green, but frame 3 has a transparent section in the corner → first-pixel-of-edge sampling for frame 0 still works, but `--first-key` is the only way to override, and there's no per-frame override.
**Fix**: in `remove-bg.py`, scan each frame and decide per-frame. Print a per-frame method summary. Allow `--first-key` to keep current behavior (skip per-frame scan for speed).

### G9. Mixed-alpha sheets (medium)
**Repro**: a sheet with some frames on transparent background and others on green.
**Fix**: same as G8 — per-frame detection. If frame already has alpha channel with no opaque pixels touching the border → `none` (skip bg removal). Else → chroma/rembg.

### G11. Atlas wastes canvas (low)
**Repro**: 1 frame at 256×256 → atlas 2048×256 (16x waste).
**Fix**: when `frames.length * frameSize^2 < cols*frameSize^2 / 2`, compute minimum cols that fits and use that. Add `--atlas-fill` flag to force the old behavior. For 1 frame → 256×256 canvas. For 5 frames → 5×256=1280 wide.

### G13. No resize at extract (medium)
**Fix**: add `--resize <N>` to extract — sharp `.resize(N)` before saving. Useful when source cells are 1024×1024 and you don't want 4 MB raw crops.

## New flags summary

| Script | Flag | Purpose |
|---|---|---|
| `extract-cells.mjs` | `--map-file <path>` | Read cell map from JSON file (alternative to `--map`) |
| `extract-cells.mjs` | `--resize <N>` | Resize each cropped cell to N×N pixels |
| `extract-cells.mjs` | `--no-trim-gaps` | Skip the auto-gap-trim in grid mode |
| `extract-cells.mjs` | `--verbose` | Show full error stack traces on failure |
| `remove-bg.py` | `--per-frame` | Detect method per-frame (default: off, keep `--first-key` behavior) |
| `remove-bg.py` | `--pad <N>` | Extra transparent padding around content (default 0) |
| `build-atlas.mjs` | `--atlas-fill` | Force the old 8-col grid layout (default: auto-fit) |
| `build-atlas.mjs` | `--verbose` | Show full error stack traces on failure |

## New eval sheet (proposed)

`evals/files/broken-grid.png` — a sheet where the natural grid is 4×1 with 200×256 cells but the user might incorrectly pass `--cols 3 --rows 1`. Should error with the suggestion `Use --cols 4`.