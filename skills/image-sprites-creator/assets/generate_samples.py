#!/usr/bin/env python3
"""
generate_samples.py — Generate the additional sample sheets used by the
skill's evals. Creates 2 PNGs:

  assets/irregular-spritesheet.png : 4 cells in row 1 (irregular widths —
                                     hand-drawn on green background) + 1
                                     label cell on the right
  assets/green-spritesheet.png      : 1 single 256x256 cell on solid green

Both deterministic: same output every time.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw
import math

CELL = 256
OUT = Path(__file__).resolve().parent


def draw_hero(draw: ImageDraw.ImageDraw, cx: int, cy: int, color: tuple):
    """Draw a simple 'hero' silhouette: head circle + body rectangle."""
    head_r = 32
    body_h = 70
    body_w = 50
    # head
    draw.ellipse([cx - head_r, cy - 60 - head_r, cx + head_r, cy - 60 + head_r],
                 fill=color, outline=(0, 0, 0), width=3)
    # body
    draw.rectangle([cx - body_w // 2, cy - 50, cx + body_w // 2, cy - 50 + body_h],
                   fill=color, outline=(0, 0, 0), width=3)
    # legs
    draw.line([(cx - 18, cy + 20), (cx - 18, cy + 60)], fill=color, width=8)
    draw.line([(cx + 18, cy + 20), (cx + 18, cy + 60)], fill=color, width=8)
    # arms
    draw.line([(cx - 40, cy - 40), (cx - 40, cy - 5)], fill=color, width=8)
    draw.line([(cx + 40, cy - 40), (cx + 40, cy - 5)], fill=color, width=8)


def make_irregular():
    """4 hero poses (irregular widths) + 1 label cell on the right."""
    # Layout: 3 cells of width 200 + 1 cell of width 200 + 1 label cell of width 200
    widths = [200, 200, 200, 200, 200]
    total_w = sum(widths)
    h = 256
    img = Image.new("RGBA", (total_w, h), (0, 255, 0, 255))  # solid green
    draw = ImageDraw.Draw(img)

    x = 0
    colors = [(220, 80, 80), (80, 160, 220), (240, 200, 60), (180, 90, 220)]
    for i, w in enumerate(widths[:4]):
        # Cyan border (so the "label" cell looks different)
        draw.rectangle([x, 0, x + w - 1, h - 1], outline=(90, 230, 240), width=2)
        # Hero
        draw_hero(draw, x + w // 2, h // 2, colors[i])
        x += w
    # 5th cell = label
    draw.rectangle([x, 0, x + widths[4] - 1, h - 1], outline=(90, 230, 240), width=2)
    # Label text "MENU"
    draw.text((x + 60, h // 2 - 15), "MENU", fill=(255, 255, 255))
    out = OUT / "irregular-spritesheet.png"
    img.save(out, "PNG", optimize=True)
    print(f"✓ {out}  ({total_w}x{h})  widths={widths}")


def make_green():
    """Single 256x256 hero on solid green — for chroma-key test."""
    img = Image.new("RGBA", (CELL, CELL), (0, 255, 0, 255))
    draw = ImageDraw.Draw(img)
    draw_hero(draw, CELL // 2, CELL // 2 + 20, (80, 160, 220))
    out = OUT / "green-spritesheet.png"
    img.save(out, "PNG", optimize=True)
    print(f"✓ {out}  ({CELL}x{CELL})")


def main() -> int:
    make_irregular()
    make_green()
    return 0


if __name__ == "__main__":
    sys.exit(main())
