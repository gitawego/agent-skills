---
name: mmx-sprite-sheet-creator
description: >
  Generate a transparent 2D game sprite sheet (PNG) using `mmx` (MiniMax CLI) and
  ImageMagick. Use this skill whenever the user wants to create a sprite sheet
  for a game character with multiple animation sequences (idle, walk, attack,
  jump, hurt, death, etc.), or says things like "make a sprite sheet" / "create
  a sprite atlas" / "generate character animations" / "I need an 8-row sprite
  sheet for Godot/Phaser/Unity" / "generate all the animations for my character
  in one go" / "turn my character description into a sprite sheet". Always
  produces: one labeled transparent sprite-sheet PNG, one transparent PNG per
  animation row, a JSON manifest describing cell coordinates for engine
  import, and a checkerboard preview. Requires the user to provide a character
  description; ships 8 default animations (IDLE/WALK/RUN/ATTACK/JUMP/HURT/
  DEATH/SPECIAL) which the user can override.
---

# mmx-sprite-sheet-creator

Generate a transparent, game-ready 2D sprite sheet from a character description by composing multiple `mmx image generate` rows into one labeled sheet.

## When to use this skill

Use it when the user wants:
- A sprite sheet for a single game character across multiple animations.
- Output ready to drop into Godot / Phaser / Unity / LÖVE with a transparent background.
- Multiple variations to pick from (the script generates 2 per row by default).
- The default 8-row layout matching common 2D RPG/platformer engines (IDLE, WALK, RUN, ATTACK, JUMP, HURT, DEATH, SPECIAL), or a custom list.

Do **not** use this skill when:
- The user already has a sprite sheet and just wants to slice it — use `image-sprites-creator` instead.
- The user wants a single still image — call `mmx image generate` directly.
- The user wants a 3D model or non-orthogonal camera — `mmx image generate` produces 2D diffusion output, not multi-view 3D.

## What this skill produces

```
<output-dir>/
├── sprite_sheet.png           # full labeled sheet, transparent background
├── sprite_sheet_preview.png   # checkerboard preview of the same sheet
├── sprite_sheet.json          # manifest: row offsets, frame sizes, action names
└── rows/
    ├── IDLE.png               # transparent labeled row, ready to drop into Godot
    ├── WALK.png
    ├── RUN.png
    ├── ATTACK.png
    ├── JUMP.png
    ├── HURT.png
    ├── DEATH.png
    └── SPECIAL.png
```

The composite sheet has a 240px white label gutter on the left and a 100px transparent bottom margin. Rows are stacked vertically with 24px transparent gaps between them.

## Prerequisites

- `mmx` CLI installed and authenticated (`mmx auth status` should print your account).
- `magick` (ImageMagick 7) installed (`magick --version | head -1`).
- `bc` for simple math in the script.
- A character description from the user (see "Character description" below).

## Quick start

```bash
# Generate the default 8-row sprite sheet for a custom character
./scripts/mmx-sprite-sheet.sh \
  --character "Cute chibi graveyard zombie. Round head. Big adorable glowing \
purple eyes. Pale grey-green rotting skin. Green moss tufts on top of head. \
Stitched mouth with one tiny fang. Tattered dark grey hooded robe with frayed \
hem. Dark wooden cross pendant hanging on chest. Exposed bone right forearm. \
Wilted purple flowers on left shoulder. Small grey tombstone fragment in right \
hand. Worn shoes. Side profile facing right." \
  --output ./tmp/zombie_spritesheet \
  --seed 700002
```

The script will:
1. Generate 2 candidate images per animation row (16 total calls to `mmx`).
2. Composite the best of each into one labeled sheet.
3. Write per-row transparent PNGs, the composite PNG, a JSON manifest, and a checkerboard preview.

## CLI

```
./scripts/mmx-sprite-sheet.sh [options]

REQUIRED
  --character <text>       The character description. Can be multi-line. Will be
                           inserted verbatim into every per-row prompt.

OPTIONS
  --output <dir>           Output directory. Default: ./tmp/sprite_sheet
  --animations <list>      Comma-separated action names. Default: IDLE,WALK,RUN,
                           ATTACK,JUMP,HURT,DEATH,SPECIAL
  --frames <n>             Frames per row. Default: 6
  --variations <n>         Candidate images generated per row (script picks the
                           first successful download). Default: 2
  --seed <n>               Same seed used for every row — anchors the visual
                           identity of the character across rows. Default: 700002
  --label-width <px>       Width of the white label gutter on the left.
                           Default: 240
  --row-height <px>        Height of each animation row. Default: 720
  --gap <px>               Vertical gap between rows (will be transparent).
                           Default: 24
  --bottom-pad <px>        Transparent padding below the last row. Default: 100
  --keep-raw               Don't delete raw downloaded JPEGs (useful for
                           re-compositing later).
  -h | --help              Show usage.
```

## Character description — what to write

A good character description is concrete, short, and describes one specific character. **Copy the description verbatim into every row's prompt** — that's how this skill preserves character identity across animations. Don't paraphrase, don't reorder, don't "improve" wording between rows.

A good description:
- Lists visible features in declarative phrases ("Round head. Big eyes. Tattered robe.").
- Names a style ("Pure flat 2D anime cel-shaded with bold dark outlines, soft hand-painted cel shading, no 3D.").
- Specifies facing direction ("Side profile facing right.").
- Stays under ~400 characters so it fits the per-row prompt under mmx's 1500-character limit.

A bad description:
- Vague ("A cool character that looks unique").
- Lists hidden/internal traits ("Strength 7, magic resistance high").
- References specific frames or poses ("when he smiles like in frame 3").
- Asks for props beyond the character ("holding a sword that isn't part of his design").

The skill wraps your description in a fixed template that already covers the style, the row layout, and the background — see `references/lessons.md` for why the template exists and what it does.

## How it works (the pipeline)

The script does this for each animation:

1. Build a prompt of the form:
   ```
   Pure flat 2D anime cel shaded horizontal sprite strip. Six sequential
   frames left to right of the SAME character: <CHARACTER DESCRIPTION>.
   Identical scale and design across all six frames, all facing right side
   profile. Pure solid magenta #FF00FF background edge to edge filling all
   empty space, no scenery, no ground, no floor, no shadows on background,
   no text, no labels, no frame boxes. Six poses evenly spaced left to right
   with small magenta padding between frames. <ANIMATION DESCRIPTION>.
   ```
2. Call `mmx image generate --prompt ... --width 1280 --height 720 --seed $SEED --out ...`.
3. Repeat with `--n $VARIATIONS` if `--variations > 1`.
4. Keep the first successfully downloaded JPEG.

After all rows:

5. Build per-row labeled PNGs (white gutter + row image + bold label text).
6. Stack all rows vertically onto a magenta canvas with the configured gap.
7. Add the bottom pad.
8. Chroma-key the magenta background → transparent (`-fuzz 35%` — see `references/lessons.md` for why not 8%).
9. Split the per-row PNGs back out as transparent files.
10. Write the JSON manifest.
11. Render the checkerboard preview.

## Animation descriptions — customizing or adding rows

The 8 default animations are tuned for a typical 2D RPG character. To customize, edit the `get_anim_description()` function near the top of `scripts/mmx-sprite-sheet.sh`. See `references/animations.md` for the actual text of each animation, the design rationale, and how to add your own (e.g. `CROUCH`, `FALL`, `BLOCK`, `CAST_LOOP`, `VICTORY`).

## Tuning visual results

If the output looks wrong, walk through these in order:

| Symptom | Likely cause | Fix |
|---|---|---|
| Character changes between rows | Prompt drift (description reworded between rows) | Edit the script to use one `$CHAR_DESC` variable, never rebuild it per row |
| Magenta halo around character | `-fuzz` too low | Bump to 40% — characters use pink/purple eye glow that gets eaten at higher fuzz, but 35–40% is a good middle |
| Character's eyes/key details gone | `-fuzz` too high | Drop to 30% |
| Watermark/signature in corner | Single-call mega-prompt attempt | This skill never does that — it always generates rows individually |
| Output not transparent | ImageMagick wrote RGB instead of RGBA | Add `-define png:color-type=6` to the chroma-key command |
| First/last frames cut off at edges | Model ignored "edge padding" instruction | Add more padding to the character description, or re-run with a different seed |
| Animation row missing a frame (only 5 figures) | Model collapsed two poses together | Re-run just that row: `./scripts/mmx-sprite-sheet.sh --animations ATTACK --output tmp/retry_attack --seed 700003` |
| Pose direction varies (some face left) | Model ignored "side profile facing right" | Strengthen the phrase in the character description: "Strictly side profile facing right, never left, never front." |

## Engine integration

### Godot 4

The JSON manifest maps directly to a `SpriteFrames` resource. Example importer:

```python
# addons/sprite_sheet_importer.gd (sketch — adapt to your project)
extends EditorScript

func _run():
    var manifest = load("res://sprite_sheet.json")
    var tex = load("res://sprite_sheet.png")
    var frames = SpriteFrames.new()
    for action in manifest.rows:
        var row = manifest.rows[action]
        frames.add_animation(action)
        for i in manifest.rows[action].frames:
            var atlas = AtlasTexture.new()
            atlas.atlas = tex
            var fw = manifest.frame_size.width
            var fh = manifest.frame_size.height
            atlas.region = Rect2(i * fw, row.y_offset, fw, fh)
            frames.add_frame(action, atlas)
    ResourceSaver.save(frames, "res://character_sprite_frames.tres")
```

### Phaser 3

Each row PNG is already a valid atlas; load with:
```js
this.load.atlas('zombie', 'rows/IDLE.png', null, { frameWidth: 213, frameHeight: 720 });
```
For the full sheet, use a JSON hash atlas and a custom loader that reads `sprite_sheet.json`.

### Unity

Use the per-row PNGs as separate sprite arrays. The composite PNG works as a single texture; slice manually in the Sprite Editor using `frame_size` from the manifest.

## Cost & timing

- Each `mmx image generate` call costs 1 image-generation unit (~$0.02–0.05).
- Default 8 rows × 2 variations = 16 calls ≈ 30–60 seconds total wall time.
- Single `--variations 1 --animations IDLE,WALK` = 2 calls ≈ 5 seconds.
- Each generated JPEG is ~250 KB, downloads via mmx's CDN.

## Files in this skill

- `SKILL.md` — this file.
- `scripts/mmx-sprite-sheet.sh` — the full pipeline. One file, no external dependencies beyond `mmx` and `magick`.
- `references/animations.md` — default animation descriptions and how to extend the set.
- `references/lessons.md` — gotchas learned from the original zombie sprite-sheet work, with the reasoning behind each pipeline choice. Read this if you want to modify the script.