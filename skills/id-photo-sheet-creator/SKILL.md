---
name: id-photo-sheet-creator
description: Build print-ready sheets of repeated ID/passport/visa photos from a single portrait. Use this skill whenever the user wants to print multiple copies of a single photo on one sheet, arrange ID photos for cutting, generate a passport photo sheet at a specific paper size (R5/4x6/5x7/A4), or says things like "print N copies of this photo on one page" / "make a 2x3 grid of my ID photo" / "passport photo print sheet" / "照片打印 / 证件照排版 / 打印一版". Handles rows/cols, margins, cutting gaps, DPI (default 300, supports 350), contain vs cover fit, and embeds proper DPI metadata so the file prints at the right size. Works on JPEG/PNG inputs.
---

# ID Photo Sheet Creator

## When to use

- User has a single portrait and wants multiple copies on one printable sheet
- Specifying a paper size (R5 = 89×127mm, 4×6", 5×7", A4, etc.) and a row × column grid
- Specifying cutting gaps between photos and/or margins around the edge
- Asking for a print-resolution image (DPI matters for physical print size)

Do NOT use this skill for: general image editing, photo collage with different photos, document scanning, or anything that isn't "one photo, repeated N times, on a printable sheet."

## Approach

Always use the bundled Python script (`scripts/build_sheet.py`). It uses Pillow, which handles colorspaces correctly. **Do not use ImageMagick** — its `xc:white` canvas comes up single-channel Gray in IM7, which flattens the whole composite to grayscale (a bug we hit in development). Pillow's `Image.new("RGB", ...)` stays RGB throughout.

## Quick start

```bash
python3 scripts/build_sheet.py \
  --input /path/to/photo.jpg \
  --output /path/to/sheet.jpg \
  --sheet 127x89 --rows 2 --cols 3 \
  --margin 2 --gap 2 --dpi 300
```

Defaults: **R5 portrait sheet (89×127mm)**, 2×3 grid, 2mm margin, 2mm gap, 300 DPI, contain fit, white background.

## Inputs the user controls

| Flag           | Default    | Notes                                                              |
|----------------|------------|--------------------------------------------------------------------|
| `--input`      | (required) | JPEG or PNG of the portrait                                        |
| `--output`     | (required) | `.jpg` for photo-realistic, `.png` for lossless                    |
| `--sheet`      | `89x127`   | `WxH` in mm. R5 portrait (default) is the Chinese standard ID-photo size. Common alternates: `127x89` (5×7" landscape), `102x152` (4×6"), `210x297` (A4) |
| `--rows`       | `2`        |                                                                      |
| `--cols`       | `3`        |                                                                      |
| `--margin`     | `2`        | Outer margin in mm                                                   |
| `--gap`        | `2`        | Gap between cells for cutting, in mm                                 |
| `--dpi`        | `300`      | Use `350` for high-quality photo printing                            |
| `--fit`        | `contain`  | `contain` letterboxes (keeps full photo), `cover` fills + crops     |
| `--background` | `white`    | Any Pillow color spec: `#fff`, `rgb(240,240,240)`, etc.             |

## Output

The script writes the file AND prints a summary of actual pixel/mm dimensions, including the resolved cell size. Verify the summary matches the user's intent before declaring success.

## Things to confirm with the user up front

**Always ask before generating.** Most outputs we've had to throw away came from guessing these. A short question with sensible options beats a wrong sheet.

1. **Sheet size AND orientation** — REQUIRED. A 5×7" sheet is either 127×89mm (landscape) or 89×127mm (portrait). The R5/4×6 paper sizes default to portrait in Chinese print conventions. If the user does not specify orientation explicitly, ask. Don't infer it from the source image's aspect — a portrait source still prints well on a landscape sheet, and vice versa; the user's intent matters more than the source shape. Default if they pick "no preference": R5 portrait (89×127mm), since that's the standard ID-photo size.
2. **Grid (rows × cols)** — ask if unclear. 2×3 is the standard for R5.
3. **Fit mode**: contain (letterbox, no crop) vs cover (fill, crop). Portrait source + rectangular cell almost always means contain. Don't silently crop a face. Default: contain.
4. **DPI**: 300 is the print standard. Use 350 only when the user asks for higher quality or the lab specifies it. Default: 300.
5. **Output format**: JPEG for photos (smaller), PNG only if the user needs lossless or transparency. Default: JPEG.

## What the script does NOT do

- No face detection, no auto-crop to passport dimensions, no background removal
- No print marks (bleed, crop marks, color bars) — pure sheet of photos
- No color management beyond sRGB defaults; assumes sRGB input and sRGB output
- No batch input — one source photo per run. For multiple sources, run multiple times or wrap in a loop.

If the user needs any of the above, tell them clearly and suggest a different tool (e.g. ImageMagick for crop marks, `rembg` for background removal).

## Verifying the output

After running the script, run this to confirm the file is correct (Pillow won't silently drop colors the way ImageMagick did):

```python
from PIL import Image
im = Image.open(output_path)
assert im.mode == "RGB", f"Expected RGB, got {im.mode}"
assert im.info.get("dpi") == (cfg_dpi, cfg_dpi), f"DPI metadata wrong: {im.info.get('dpi')}"
# spot-check: a face pixel should not be (128, 128, 128) gray
face_pixel = im.getpixel((w//4, h//4))  # rough cell center
assert face_pixel != (128, 128, 128), "Image came out grayscale!"
```

## Common pitfalls

- **Forgetting orientation**: a `2×3` grid is rows×cols. On a 127×89mm landscape sheet, 2 rows × 3 cols is what people usually want. On an 89×127mm portrait sheet, the same `2×3` becomes 3 cols × 2 rows in the printed image (rows=2, cols=3), but the cell aspect changes — ask if unsure.
- **Margins in pixels vs mm**: the user thinks in mm, the script rounds to pixels. Sub-pixel rounding means the right/bottom margin may differ from the others by 1-2px (~0.05mm at 300dpi). Don't pretend it's exact.
- **DPI mismatch in image viewer**: opening a 300dpi JPEG in a typical image viewer ignores DPI and shows it at 72dpi on screen, looking huge. This is correct — the file is print-sized, not screen-sized.
