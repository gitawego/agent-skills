#!/usr/bin/env python3
"""
generate_sample.py — Create a sample sprite sheet for self-testing the
image-sprites-creator skill.

Outputs assets/sample-spritesheet.png with 6 cells in a 3x2 grid:
  Row 0: idle (yellow circle), walk (blue triangle), run (red diamond)
  Row 1: jump (green pentagon), attack (purple star), hurt (orange square)

Each cell is 256x256 on a gray checkered background. The skill should be
able to detect this as a regular grid and produce 6 frames + 6 animations.

This is a deterministic generator: same output every time.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

CELL = 256
COLS = 3
ROWS = 2
SQUARE_SIZE = 140  # shape size within the cell

# Cell colors (BG in 6 distinct colors for easy visual identification)
COLORS = {
    "idle":   (250, 220, 80),    # yellow
    "walk":   (90, 160, 230),    # blue
    "run":    (230, 90, 90),     # red
    "jump":   (90, 200, 120),    # green
    "attack": (180, 90, 220),    # purple
    "hurt":   (240, 150, 60),    # orange
}

# Animation keys (will be detected in the resulting atlas)
ANIMS = list(COLORS.keys())


def checkered_bg(w: int, h: int, square: int = 32) -> Image.Image:
    """Gray checkered background (Phaser docs style)."""
    img = Image.new("RGBA", (w, h), (90, 90, 90, 255))
    px = img.load()
    for y in range(0, h, square):
        for x in range(0, w, square):
            if ((x // square) + (y // square)) % 2 == 0:
                for dy in range(min(square, h - y)):
                    for dx in range(min(square, w - x)):
                        px[x + dx, y + dy] = (60, 60, 60, 255)
    return img


def draw_shape(draw: ImageDraw.ImageDraw, anim: str, cx: int, cy: int, size: int, color: tuple):
    """Draw a shape that varies by animation name (so the atlas is interesting)."""
    half = size // 2
    if anim == "idle":
        # Yellow circle
        draw.ellipse([cx - half, cy - half, cx + half, cy + half], fill=color, outline=(0, 0, 0), width=4)
    elif anim == "walk":
        # Blue triangle (slight tilt to suggest motion)
        draw.polygon([(cx, cy - half), (cx + half, cy + half), (cx - half, cy + half)], fill=color, outline=(0, 0, 0), width=4)
    elif anim == "run":
        # Red diamond
        draw.polygon([(cx, cy - half), (cx + half, cy), (cx, cy + half), (cx - half, cy)], fill=color, outline=(0, 0, 0), width=4)
    elif anim == "jump":
        # Green pentagon (pointing up)
        import math
        pts = []
        for i in range(5):
            angle = math.radians(-90 + i * 72)
            pts.append((cx + half * 0.95 * math.cos(angle), cy + half * 0.95 * math.sin(angle)))
        draw.polygon(pts, fill=color, outline=(0, 0, 0), width=4)
    elif anim == "attack":
        # Purple star (5-pointed)
        import math
        pts = []
        for i in range(10):
            angle = math.radians(-90 + i * 36)
            r = half if i % 2 == 0 else half * 0.45
            pts.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
        draw.polygon(pts, fill=color, outline=(0, 0, 0), width=4)
    elif anim == "hurt":
        # Orange square with "X" eyes
        draw.rectangle([cx - half, cy - half, cx + half, cy + half], fill=color, outline=(0, 0, 0), width=4)
        # X eyes
        eye = 18
        eye_y = cy - 20
        for ex in (cx - 30, cx + 30):
            draw.line([(ex - eye // 2, eye_y - eye // 2), (ex + eye // 2, eye_y + eye // 2)], fill=(0, 0, 0), width=4)
            draw.line([(ex + eye // 2, eye_y - eye // 2), (ex - eye // 2, eye_y + eye // 2)], fill=(0, 0, 0), width=4)


def main() -> int:
    here = Path(__file__).resolve().parent
    out_dir = here  # assets/ next to this script
    out_dir.mkdir(parents=True, exist_ok=True)

    w = CELL * COLS
    h = CELL * ROWS
    img = checkered_bg(w, h)
    draw = ImageDraw.Draw(img)

    # Draw each cell
    for idx, anim in enumerate(ANIMS):
        col = idx % COLS
        row = idx // COLS
        cx = col * CELL + CELL // 2
        cy = row * CELL + CELL // 2
        # Light cell border (white outline) to mark the grid
        x1, y1 = col * CELL, row * CELL
        x2, y2 = x1 + CELL - 1, y1 + CELL - 1
        draw.rectangle([x1, y1, x2, y2], outline=(255, 255, 255, 180), width=2)
        # Shape
        draw_shape(draw, anim, cx, cy, SQUARE_SIZE, COLORS[anim])

    out = out_dir / "sample-spritesheet.png"
    img.save(out, "PNG", optimize=True)
    print(f"✓ Sample sprite sheet: {out}")
    print(f"  Size: {w}x{h} ({COLS} cols x {ROWS} rows of {CELL}x{CELL})")
    print(f"  Cells: {ANIMS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
