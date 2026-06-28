#!/usr/bin/env python3
"""
remove-bg.py — Remove the background from each cropped frame, square-center
the content (preserving the bottom anchor so a walk cycle's feet stay aligned
across frames), and write 256x256 transparent PNGs.

Methods (auto-selected by default, override with --method):
  rembg  : U^2-Net neural matting. Best for hand-drawn / photographic / any
           background. Requires `pip install rembg[cpu]` (~170MB model on
           first run). Default.
  chroma : Fast keying. Good for known solid backgrounds (green or white).
           Set --chroma "#00ff00" for green, "#ffffff" for white, etc.
  none   : Pass-through. Useful when frames already have clean alpha.

Selection heuristic (default):
  - If the average of the image's edge pixels is close to a single color and
    the variance is low, use chroma keying with that color.
  - Otherwise fall back to rembg.

All frames are bottom-anchored (NOT bbox-centered) so character feet stay on
the same baseline across an animation cycle. Set --top-anchor to use
bbox-centering instead (good for icons / items / symmetric objects).
"""
import sys
import argparse
from io import BytesIO
from pathlib import Path
from PIL import Image
import numpy as np

# Reuse one rembg session across all frames — much faster than per-frame.
_session = None


def get_rembg_session():
    global _session
    if _session is None:
        from rembg import new_session
        _session = new_session("u2net")
    return _session


def detect_chroma_color(img_rgba: np.ndarray) -> str | None:
    """Sample the image border to find a dominant solid color (chroma key)."""
    h, w = img_rgba.shape[:2]
    # Take pixels from the 4 edges (10 px wide strips), excluding transparent ones.
    border_pixels = np.concatenate([
        img_rgba[0:10, :, :].reshape(-1, 4),
        img_rgba[h - 10:h, :, :].reshape(-1, 4),
        img_rgba[:, 0:10, :].reshape(-1, 4),
        img_rgba[:, w - 10:w, :].reshape(-1, 4),
    ])
    # Filter out transparent pixels
    opaque = border_pixels[border_pixels[:, 3] > 200]
    if len(opaque) < 50:
        return None
    # Median color of opaque border pixels
    med = np.median(opaque[:, :3], axis=0).astype(int)
    # Variance check — if the border is colorful, no chroma key
    std = np.std(opaque[:, :3], axis=0).mean()
    if std > 15:
        return None
    # If the median color is "white-ish" or "green-ish" or close to a specific color, return it
    r, g, b = med
    # Pure white / near-white
    if r > 230 and g > 230 and b > 230:
        return "#ffffff"
    # Pure green / near-green (chroma key green)
    if g > 180 and r < 100 and b < 100:
        return "#00ff00"
    # Otherwise, return the median color as a hex string (might still be a key color)
    return f"#{r:02x}{g:02x}{b:02x}"


def chroma_key(img: Image.Image, key_hex: str, tolerance: int = 60) -> Image.Image:
    """Replace pixels close to `key_hex` with transparent."""
    r, g, b = int(key_hex[1:3], 16), int(key_hex[3:5], 16), int(key_hex[5:7], 16)
    arr = np.array(img).astype(int)
    diff = np.abs(arr[..., :3] - np.array([r, g, b])).sum(axis=2)
    alpha = np.where(diff < tolerance, 0, 255).astype(np.uint8)
    out = arr.copy()
    out[..., 3] = alpha
    return Image.fromarray(out.astype(np.uint8), mode="RGBA")


def square_bottom_anchor(img: Image.Image) -> Image.Image:
    """Pad the image to a square, anchored at the BOTTOM-CENTER.

    Bottom-anchoring is critical for platformer characters: the feet must stay
    on the same baseline across walk/run/jump frames, otherwise the animation
    looks like the character is bouncing.
    """
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    w, h = img.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, side - h), img)
    return canvas


def square_center(img: Image.Image) -> Image.Image:
    """Pad the image to a square, centered on the canvas (good for items)."""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    w, h = img.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, (side - h) // 2), img)
    return canvas


def process_one(src: Path, dst: Path, method: str, key_hex: str | None, top_anchor: bool) -> None:
    raw = Image.open(src)
    arr = np.array(raw)

    if method == "rembg":
        from rembg import remove
        with open(src, "rb") as f:
            raw_bytes = f.read()
        result = remove(raw_bytes)
        if isinstance(result, Image.Image):
            cleaned = result.convert("RGBA")
        else:
            cleaned = Image.open(BytesIO(result)).convert("RGBA")
    elif method == "chroma":
        if not key_hex:
            raise RuntimeError(f"chroma method requires --chroma (auto-detect failed for {src.name})")
        cleaned = chroma_key(raw, key_hex)
    elif method == "none":
        cleaned = raw.convert("RGBA") if raw.mode != "RGBA" else raw
    else:
        raise RuntimeError(f"Unknown method: {method}")

    if top_anchor:
        squared = square_center(cleaned)
    else:
        squared = square_bottom_anchor(cleaned)

    final = squared.resize((256, 256), Image.Resampling.LANCZOS)
    final.save(dst, "PNG", optimize=True)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("input", help="Input directory of raw cropped frames")
    p.add_argument("output", help="Output directory for clean frames")
    p.add_argument("--method", choices=["auto", "rembg", "chroma", "none"], default="auto")
    p.add_argument("--chroma", default=None, help="Hex color for chroma key (e.g. #00ff00)")
    p.add_argument("--top-anchor", action="store_true", help="Center-crop instead of bottom-anchored")
    p.add_argument("--first-key", default=None,
                   help="Method to use for the very first frame (overrides auto-detection result)")
    args = p.parse_args()

    in_dir = Path(args.input)
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    sources = sorted(in_dir.glob("*.png"))
    if not sources:
        print(f"✗ no PNGs found in {in_dir}", file=sys.stderr)
        return 1

    method = args.method
    key = args.chroma

    if method == "auto":
        # Inspect the first frame to pick a method
        first = np.array(Image.open(sources[0]))
        detected = detect_chroma_color(first)
        if detected is not None:
            method = "chroma"
            key = key or detected
            print(f"Auto-detected solid background: {key} → using chroma key")
        else:
            method = "rembg"
            print(f"Auto-detected non-solid background → using rembg")

    if method == "rembg":
        # Pre-warm the model so the first frame isn't slow
        print("Loading rembg model (u2net, ~170MB on first run)...")
        get_rembg_session()

    for i, src in enumerate(sources, 1):
        dst = out_dir / src.name
        try:
            process_one(src, dst, method, key, args.top_anchor)
            if i == 1 or i % 8 == 0 or i == len(sources):
                print(f"  [{i}/{len(sources)}] {src.name} OK ({method})")
        except Exception as e:
            print(f"  [{i}/{len(sources)}] {src.name} FAILED: {e}", file=sys.stderr)
    print(f"✓ Done. Output: {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
