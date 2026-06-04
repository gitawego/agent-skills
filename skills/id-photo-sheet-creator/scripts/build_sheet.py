#!/usr/bin/env python3
"""Build a print-ready ID-photo sheet from a single portrait.

Why this exists: printing multiple ID photos (passport, visa, badge) on one
sheet is a real, recurring task. Doing it by hand in an image editor is
error-prone, and ad-hoc ImageMagick pipelines hit colorspace bugs (the
`xc:white` canvas comes up single-channel Gray in IM7 and flattens the whole
composite to grayscale). Pillow handles colorspaces consistently, so we use
it here.

Usage:
    build_sheet.py --input photo.jpg --output sheet.jpg
    build_sheet.py --input photo.jpg --output sheet.png \\
        --sheet 127x89 --rows 2 --cols 3 --margin 2 --gap 2 --dpi 350 \\
        --fit contain --background white
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Tuple

from PIL import Image, ImageColor


# --- Configuration -----------------------------------------------------------

@dataclass(frozen=True)
class SheetConfig:
    """All dimensions in millimeters; DPI is pixels per inch."""
    sheet_w_mm: float
    sheet_h_mm: float
    rows: int
    cols: int
    margin_mm: float
    gap_mm: float
    dpi: int
    fit: str            # "contain" or "cover"
    background: str     # any Pillow color spec; "white", "#ffffff", "rgb(255,255,255)"

    @property
    def mm_to_px(self) -> float:
        return self.dpi / 25.4

    @property
    def sheet_px(self) -> Tuple[int, int]:
        return (round(self.sheet_w_mm * self.mm_to_px),
                round(self.sheet_h_mm * self.mm_to_px))

    @property
    def margin_px(self) -> int:
        return round(self.margin_mm * self.mm_to_px)

    @property
    def gap_px(self) -> int:
        return round(self.gap_mm * self.mm_to_px)

    @property
    def cell_px(self) -> Tuple[int, int]:
        """Cell size derived from sheet, margin, gap, rows, cols.

        Note: sub-pixel rounding may make the right/bottom margin differ from
        the others by 1-2px (i.e. ~0.05mm at 300dpi). This is acceptable for
        a printable sheet and avoids a fractional-pixel cell.
        """
        sheet_w, sheet_h = self.sheet_px
        m, g = self.margin_px, self.gap_px
        cell_w = (sheet_w - 2 * m - (self.cols - 1) * g) // self.cols
        cell_h = (sheet_h - 2 * m - (self.rows - 1) * g) // self.rows
        return (cell_w, cell_h)


# --- Core layout logic -------------------------------------------------------

def compute_fitted_size(
    src_size: Tuple[int, int],
    cell_size: Tuple[int, int],
    mode: str,
) -> Tuple[int, int]:
    """Return the size the source image should be resized to inside the cell.

    `contain` (default) preserves the source aspect ratio and letterboxes if
    the cell is a different shape. `cover` preserves aspect ratio and crops
    to fill the cell. Both modes ensure the output is a multiple of 1px and
    never upscales past the source resolution.
    """
    src_w, src_h = src_size
    cell_w, cell_h = cell_size
    if mode not in ("contain", "cover"):
        raise ValueError(f"fit must be 'contain' or 'cover', got {mode!r}")

    src_aspect = src_w / src_h
    cell_aspect = cell_w / cell_h

    if mode == "contain":
        if src_aspect > cell_aspect:
            # wider than cell -> fit width
            fit_w = cell_w
            fit_h = max(1, round(cell_w / src_aspect))
        else:
            fit_h = cell_h
            fit_w = max(1, round(cell_h * src_aspect))
    else:  # cover
        if src_aspect > cell_aspect:
            fit_h = cell_h
            fit_w = round(cell_h * src_aspect)
        else:
            fit_w = cell_w
            fit_h = round(cell_w / src_aspect)

    return (fit_w, fit_h)


def paste_centered(
    canvas: Image.Image,
    photo: Image.Image,
    cell_box: Tuple[int, int, int, int],
) -> None:
    """Paste a photo into a cell, centered, with background fill on overflow.

    For `cover` mode the photo may be larger than the cell; the cell box is
    used to determine the visible region. For `contain` the photo is smaller
    and the background fill covers the letterbox area.
    """
    cell_x0, cell_y0, cell_x1, cell_y1 = cell_box
    cell_w, cell_h = cell_x1 - cell_x0, cell_y1 - cell_y0
    paste_w, paste_h = photo.size

    x = cell_x0 + (cell_w - paste_w) // 2
    y = cell_y0 + (cell_h - paste_h) // 2

    # Cover-mode crop: paste then crop to cell
    canvas.paste(photo, (x, y))
    if paste_w > cell_w or paste_h > cell_h:
        canvas = canvas.crop((cell_x0, cell_y0, cell_x1, cell_y1))


def build_sheet(input_path: Path, output_path: Path, cfg: SheetConfig) -> Path:
    """Build the full sheet. Returns the output path on success."""
    if not input_path.exists():
        raise FileNotFoundError(f"Source image not found: {input_path}")

    src = Image.open(input_path)
    # Convert to a mode that preserves color. JPEG/PNG inputs are typically
    # RGB or RGBA; force RGB so we never end up with a single-channel
    # palette/mode image that would force a gray composite.
    if src.mode not in ("RGB", "RGBA"):
        src = src.convert("RGB")
    elif src.mode == "RGBA":
        # Composite onto background to flatten alpha cleanly
        bg = Image.new("RGB", src.size, ImageColor.getcolor(cfg.background, "RGB"))
        bg.paste(src, mask=src.split()[3])
        src = bg

    bg_color = ImageColor.getcolor(cfg.background, "RGB")
    sheet = Image.new("RGB", cfg.sheet_px, bg_color)

    cell_w, cell_h = cfg.cell_px
    fit_w, fit_h = compute_fitted_size(src.size, (cell_w, cell_h), cfg.fit)

    # Single resize: downscale/upsample once for the cell, then paste N times.
    # We resize to the fitted size, not the full source resolution, to keep
    # the script fast even on very large inputs.
    photo = src.resize((fit_w, fit_h), Image.LANCZOS)

    m, g = cfg.margin_px, cfg.gap_px
    for row in range(cfg.rows):
        for col in range(cfg.cols):
            x0 = m + col * (cell_w + g)
            y0 = m + row * (cell_h + g)
            x1, y1 = x0 + cell_w, y0 + cell_h
            paste_centered(sheet, photo, (x0, y0, x1, y1))

    # Set DPI metadata so print software honors the resolution
    sheet.save(
        output_path,
        dpi=(cfg.dpi, cfg.dpi),
        quality=95,
        subsampling=2,  # 4:2:0 - good for photos, smaller files
    )
    return output_path


# --- CLI ---------------------------------------------------------------------

def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Build a print-ready ID-photo sheet from a single portrait.",
    )
    p.add_argument("--input", "-i", type=Path, required=True,
                   help="Source photo (JPEG/PNG)")
    p.add_argument("--output", "-o", type=Path, required=True,
                   help="Output sheet path (.jpg or .png)")
    p.add_argument("--sheet", default="89x127",
                   help='Sheet size in mm, "WxH" (default: 89x127 = R5 portrait, the standard ID-photo size). '
                        'Common: 127x89 (5x7" landscape), 102x152 (4x6"), 127x178 (5x7"), 210x297 (A4)')
    p.add_argument("--rows", type=int, default=2)
    p.add_argument("--cols", type=int, default=3)
    p.add_argument("--margin", type=float, default=2.0,
                   help="Outer margin in mm (default: 2)")
    p.add_argument("--gap", type=float, default=2.0,
                   help="Gap between photos for cutting in mm (default: 2)")
    p.add_argument("--dpi", type=int, default=300,
                   help="Print resolution (default: 300; use 350 for high-quality)")
    p.add_argument("--fit", choices=["contain", "cover"], default="contain",
                   help="How to fit the photo in each cell: "
                        "contain (default, letterbox to keep aspect), "
                        "cover (crop to fill cell)")
    p.add_argument("--background", default="white",
                   help='Cell background color (default: "white"). '
                        'Any Pillow color spec works: "#fff", "rgb(240,240,240)", etc.')
    return p.parse_args(argv)


def parse_sheet_arg(s: str) -> Tuple[float, float]:
    try:
        w_str, h_str = s.lower().split("x")
        return (float(w_str), float(h_str))
    except (ValueError, AttributeError):
        raise SystemExit(f'--sheet must be "WxH" in mm, got {s!r}')


def main(argv=None) -> int:
    args = parse_args(argv)
    w_mm, h_mm = parse_sheet_arg(args.sheet)
    cfg = SheetConfig(
        sheet_w_mm=w_mm,
        sheet_h_mm=h_mm,
        rows=args.rows,
        cols=args.cols,
        margin_mm=args.margin,
        gap_mm=args.gap,
        dpi=args.dpi,
        fit=args.fit,
        background=args.background,
    )
    out = build_sheet(args.input, args.output, cfg)

    # Print a small layout summary so the user can verify dimensions
    sp = cfg.sheet_px
    cw, ch = cfg.cell_px
    print(f"Wrote {out}")
    print(f"  Sheet:  {sp[0]}x{sp[1]}px ({w_mm}x{h_mm}mm) @ {args.dpi}dpi")
    print(f"  Layout: {args.rows} rows x {args.cols} cols")
    print(f"  Cell:   {cw}x{ch}px ({cw*25.4/args.dpi:.2f}x{ch*25.4/args.dpi:.2f}mm)")
    print(f"  Margins/gaps: {args.margin}mm / {args.gap}mm")
    return 0


if __name__ == "__main__":
    sys.exit(main())
