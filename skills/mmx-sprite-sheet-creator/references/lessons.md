# Lessons from the original sprite-sheet work

Everything in `scripts/mmx-sprite-sheet.sh` was learned the hard way generating the chibi graveyard zombie sprite sheet. If you're tempted to modify the script, read this first — most of the "why" is here.

## 1. Diffusion image models can't render strict N×M grid layouts

When you prompt for "8 rows × 6 columns" in a single image, the model produces roughly 8 figures in some loose grid (3-3-2, 4-5, 4-4 — never the strict 8×6). This is a fundamental property of diffusion models: they render content density, not exact cell counts.

**What this skill does instead:** generate each row as a separate `mmx image generate` call with `Six sequential frames left to right` in the prompt, then composite. The model handles 1×6 reliably; it doesn't handle 8×6.

**If you want to skip the per-row compositing:** you'll need a different pipeline. Image models won't give you the grid you want.

## 2. The character description must be **verbatim** across all rows

Every per-row prompt inserts the same `$CHARACTER` string. If you ever reword it — even to "fix" punctuation — the model will treat it as a new character. The first 30 minutes of the original zombie session were spent debugging character drift that turned out to be the script paraphrasing the description.

**Concrete check:** open two prompt files and `diff` them. The only difference should be the motion description appended at the end.

## 3. Same seed + same description = recognizable same character

`mmx image generate --seed 700002` with the same prompt produces the same image. With different prompts but the same seed, the model still anchors to a similar visual identity. We saw this consistently: the IDLE, WALK, RUN, ATTACK, JUMP, HURT, DEATH, and SPECIAL rows all looked like the same character even though the prompts varied.

**Why this works:** the seed initializes the diffusion noise. The character description shapes the denoising. Same seed → same starting noise → same "person" emerges regardless of the motion described.

**Don't rely on `--subject-ref type=character`.** In our testing, this flag actually *increased* drift — it returned different characters entirely (e.g., a blue-dressed girl for a zombie prompt). Skip it.

## 4. mmx's "magenta" is pinkish, not pure #FF00FF

We expected `#FF00FF` from the model but got samples in the `#D44394` to `#F0459D` range — a pinkish-magenta that's measurably different from pure magenta.

**Distance math:**
- Pure magenta: `(255, 0, 255)`
- Model output: `(214, 67, 148)` (typical)
- Euclidean distance: ~133 of max 442
- **Fuzz needed: ~30%**, not 8%

The script uses `-fuzz 35%` as a default. If your character has purple eye glow or pink magic effects, those are at the edge of the chroma-key boundary. You may need to lower fuzz to 25-30% to preserve them, or accept that some color details will be subtly eaten at the edge.

**Verification:** always render the checkerboard preview and look at the edges. If you see a magenta halo around the character, increase fuzz. If the eyes or effects look hollowed out, decrease fuzz.

## 5. The 1500-character prompt limit is hard

mmx errors out (or truncates) above ~1500 characters. With the standard template + a long character description, you can easily hit this.

**The script's prompt is ~700 characters** with the default zombie description. If you supply a much longer character description (e.g., a 700-character D&D character sheet), the prompt will overflow.

**Mitigation:** trim your character description to ~400 characters. List visible features only, not backstory or stats.

## 6. Side-profile camera instruction is partly ignored

The prompt says "all facing right side profile" but the model defaults to a 3/4 front view. This is fine for top-down or 3/4-perspective games. If you need true orthogonal side-view (like classic beat-'em-ups), this skill won't get you there — diffusion models don't render true side profiles reliably.

**Workaround:** add the word "Strictly" to the prompt: "Strictly side profile facing right, never left, never front." This works about 50% of the time. For real side profiles, find a model trained on sprite sheets specifically (none of the mmx models are).

## 7. Single-call mega-prompts add a watermark/signature

When we tried generating all 8 rows in a single image, the model added a small "ANCISOL" / "CLICKRUA" signature in the bottom-right corner. This appears to be a watermark or training-data signature that emerges when the image is large or complex.

**Per-row calls don't have this issue** in our testing. The script does per-row, so we never see this.

**If you see a signature on a row:** re-run that row with `--seed $((SEED + 1))`. Usually it goes away.

## 8. The first/last frames get cropped at canvas edges

The model doesn't reliably honor "edge padding" instructions. The leftmost frame is often cut at the head, the rightmost at the feet.

**Fix in the script:** the canvas is 1280×720 and the model puts six figures across it. With edge crops, the effective content area is roughly 100-1180 horizontally and 80-680 vertically. The manifest's `frame_size` uses the full 1280/6 = 213px wide; your engine will need to crop slightly. Or accept the edge cut and have your game engine trim each frame's bounding box at load time.

## 9. Variations > 1 helps when one row looks bad

The script defaults to `--variations 2`. This generates two images per row and keeps the first. If a row comes back with weird poses (e.g., the WALK row faces left, or the HURT row has the wrong weapon), re-run with `--variations 4` and you'll usually get at least one usable frame sequence. Then the script picks the first by file order, which is `*_001.jpg` — not necessarily the best one.

**Future improvement:** add visual similarity scoring to pick the variation closest to the IDLE row's character. We didn't build this; picking the first was good enough.

## 10. mmx output goes via CDN, not local pipe

`mmx image generate --out /path/file.jpg` actually downloads the generated image from a CDN URL. If your network blocks the CDN, `--out` silently produces nothing. The `--response-format base64` flag bypasses this — useful when running offline or behind firewalls.

The script uses `--out-dir` with `--out-prefix`, which causes mmx to download all variations into the directory. If your environment has the CDN blocked, swap those flags for `--response-format base64`.

## Quick reference: default values and why

| Setting | Value | Why |
|---|---|---|
| `--width --height` | 1280 × 720 | Standard 16:9; gives model room for 6 frames + padding |
| `--seed` | 700002 | Anchor for character consistency; same value across all rows |
| `--variations` | 2 | Cheap insurance against one bad row |
| `--fuzz` | 35% | Handles pinkish-magenta output, preserves most character details |
| `--label-width` | 240px | Enough room for 8-character labels at 56pt font |
| `--gap` | 24px | Visible separation between rows; gets keyed out |
| `--bottom-pad` | 100px | Per system role spec; gets keyed out |
| `--row-height` | 720px | Matches the mmx output dimensions |

Change these with intent. The defaults are tuned for the 8-standard-animations RPG layout.