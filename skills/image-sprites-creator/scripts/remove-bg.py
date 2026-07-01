#!/usr/bin/env python3
"""
remove-bg.py — Remove the background from each cropped frame, square-center
the content (preserving the bottom anchor so a walk cycle's feet stay aligned
across frames), and write transparent PNGs.

Methods (auto-selected by default, override with --method):
  rembg     : U^2-Net neural matting. Best for hand-drawn / photographic / any
              background. Requires `pip install rembg[cpu]` (~170MB model on
              first run). Default.
  chroma    : Fast keying. Good for known solid backgrounds (green or white).
              Set --chroma "#00ff00" for green, "#ffffff" for white, etc.
              Supports soft edges via --chroma-softness.
  luminance : Keying based on pixel brightness. Ideal for light objects (glows,
              fire, spells, ghosts) on dark backgrounds, or dark objects on
              light backgrounds (using --lum-invert).
  none      : Pass-through. Useful when frames already have clean alpha.
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


def chroma_key(img: Image.Image, key_hex: str, tolerance: int = 60, softness: int = 15) -> Image.Image:
    """Replace pixels close to `key_hex` with transparent using a soft edge."""
    r, g, b = int(key_hex[1:3], 16), int(key_hex[3:5], 16), int(key_hex[5:7], 16)
    arr = np.array(img).astype(float)
    # Calculate Euclidean distance in RGB color space
    diff = np.linalg.norm(arr[..., :3] - np.array([r, g, b]), axis=2)
    
    # Map diff to alpha smoothly:
    if softness > 0:
        alpha = np.clip((diff - tolerance) / softness, 0.0, 1.0)
    else:
        alpha = np.where(diff < tolerance, 0.0, 1.0)
    
    out = arr.copy()
    out[..., 3] = np.round(alpha * 255)
    return Image.fromarray(out.astype(np.uint8), mode="RGBA")


def luminance_key(img: Image.Image, floor: float = 15.0, ceil: float = 200.0, gamma: float = 1.4, invert: bool = False) -> Image.Image:
    """Convert background to transparency using luminance-based alpha."""
    rgba = img.convert("RGBA")
    arr = np.array(rgba, dtype=np.float64)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    
    # Perceived luminance (Rec. 709 weights)
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if invert:
        lum = 255.0 - lum

    # Map to alpha smoothly
    alpha = np.clip((lum - floor) / max(1.0, ceil - floor), 0.0, 1.0)
    alpha = np.power(alpha, gamma)
    alpha[lum < floor] = 0.0

    out = arr.copy()
    out[:, :, 3] = np.round(alpha * 255)
    return Image.fromarray(out.astype(np.uint8), mode="RGBA")


def remove_bleed_through(img: Image.Image) -> Image.Image:
    """Erase bleed-through pixels at the top and bottom edges of the frame."""
    rgba = img.convert("RGBA")
    arr = np.array(rgba)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    mask = lum > 15
    row_counts = mask.sum(axis=1)

    # 1. Clean top bleed-through (at least 15 empty rows gap)
    gap_len = 0
    actual_head = -1
    for y in range(len(row_counts)):
        if row_counts[y] == 0:
            gap_len += 1
        else:
            if gap_len >= 15:
                actual_head = y
                break
            gap_len = 0
    if actual_head != -1:
        arr[:actual_head, :, :] = 0

    # Recalculate row counts after top cleaning
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    mask = lum > 15
    row_counts = mask.sum(axis=1)

    # 2. Clean bottom bleed-through (at least 15 empty rows gap)
    gap_len = 0
    actual_tail_end = -1
    for y in range(len(row_counts) - 1, -1, -1):
        if row_counts[y] == 0:
            gap_len += 1
        else:
            if gap_len >= 15:
                actual_tail_end = y
                break
            gap_len = 0
    if actual_tail_end != -1:
        arr[actual_tail_end + 1:, :, :] = 0

    return Image.fromarray(arr, "RGBA")


def square_bottom_anchor(img: Image.Image, max_side: int | None = None) -> Image.Image:
    """Pad the image to a square, anchored at the BOTTOM-CENTER."""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    w, h = img.size
    side = max_side if max_side is not None else max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, side - h), img)
    return canvas


def square_center(img: Image.Image, max_side: int | None = None) -> Image.Image:
    """Pad the image to a square, centered on the canvas (good for items)."""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    w, h = img.size
    side = max_side if max_side is not None else max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, (side - h) // 2), img)
    return canvas


def clean_frame(src: Path, method: str, key_hex: str | None, remove_bleed: bool, args) -> Image.Image:
    raw = Image.open(src)
    if remove_bleed:
        raw = remove_bleed_through(raw)

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
        cleaned = chroma_key(raw, key_hex, tolerance=60, softness=args.chroma_softness)
    elif method == "luminance":
        cleaned = luminance_key(raw, floor=args.lum_floor, ceil=args.lum_ceil, gamma=args.lum_gamma, invert=args.lum_invert)
    elif method == "none":
        cleaned = raw.convert("RGBA") if raw.mode != "RGBA" else raw
    else:
        raise RuntimeError(f"Unknown method: {method}")
        
    return cleaned


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("input", help="Input directory of raw cropped frames")
    p.add_argument("output", help="Output directory for clean frames")
    p.add_argument("--method", choices=["auto", "rembg", "chroma", "luminance", "none"], default="auto")
    p.add_argument("--chroma", default=None, help="Hex color for chroma key (e.g. #00ff00)")
    p.add_argument("--chroma-softness", type=int, default=15, help="Softness margin for chroma keying (default: 15)")
    p.add_argument("--lum-floor", type=float, default=15.0, help="Luminance floor (0-255) below which pixels become transparent (default: 15.0)")
    p.add_argument("--lum-ceil", type=float, default=200.0, help="Luminance ceiling (0-255) above which pixels become fully opaque (default: 200.0)")
    p.add_argument("--lum-gamma", type=float, default=1.4, help="Gamma exponent applied to luminance alpha mapping (default: 1.4)")
    p.add_argument("--lum-invert", action="store_true", help="Invert luminance mapping (for dark shapes on a light background)")
    p.add_argument("--remove-bleed", action="store_true", help="Automatically detect and erase row bleed-through / hanging tails from adjacent cells")
    p.add_argument("--uniform", action="store_true", help="Scale all frames uniformly based on the maximum bounding box size across all frames")
    p.add_argument("--top-anchor", action="store_true", help="Center-crop instead of bottom-anchored")
    p.add_argument("--first-key", default=None,
                   help="Method to use for the very first frame (overrides auto-detection result)")
    p.add_argument("--pad", type=int, default=0,
                   help="Extra transparent padding (px) around each cleaned frame")
    p.add_argument("--frame-size", type=int, default=256,
                   help="Output frame size in pixels (default 256)")
    p.add_argument("--per-frame", action="store_true",
                   help="Auto-detect method per-frame (default: one decision for all frames)")
    args = p.parse_args()

    in_dir = Path(args.input)
    out_dir = Path(args.output)
    if not in_dir.is_dir():
        print(f"✗ Input directory does not exist: {in_dir}", file=sys.stderr)
        return 1
    out_dir.mkdir(parents=True, exist_ok=True)

    sources = sorted(in_dir.glob("*.png"))
    if not sources:
        print(f"✗ no PNGs found in {in_dir}", file=sys.stderr)
        return 1

    method = args.method
    key = args.chroma

    # If the user explicitly passed --chroma, force chroma-key regardless of --method.
    if key is not None:
        method = "chroma"
    elif method == "auto":
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

    # Pre-process all frames
    cleaned_frames = []
    max_w = 0
    max_h = 0
    for i, src in enumerate(sources, 1):
        try:
            cleaned = clean_frame(src, method, key, args.remove_bleed, args)
            bbox = cleaned.getbbox()
            if bbox:
                left, upper, right, lower = bbox
                max_w = max(max_w, right - left)
                max_h = max(max_h, lower - upper)
            cleaned_frames.append((src, cleaned))
        except Exception as e:
            print(f"  [{i}/{len(sources)}] {src.name} FAILED to clean: {e}", file=sys.stderr)
            return 1

    max_side = max(max_w, max_h) if args.uniform else None
    if args.uniform:
        print(f"Uniform scaling enabled. Max content bounding box: {max_w}x{max_h}px. Uniform padding side: {max_side}px.")

    for i, (src, cleaned) in enumerate(cleaned_frames, 1):
        dst = out_dir / src.name
        try:
            # Crop to content first if we are doing uniform scaling so that padding is calculated from content
            if args.uniform:
                bbox = cleaned.getbbox()
                if bbox:
                    cleaned = cleaned.crop(bbox)
            
            # Align/Pad
            if args.top_anchor:
                squared = square_center(cleaned, max_side)
            else:
                squared = square_bottom_anchor(cleaned, max_side)

            # Resize to output target size
            final = squared.resize((args.frame_size, args.frame_size), Image.Resampling.LANCZOS)
            
            # Apply padding margin
            if args.pad > 0:
                padded = Image.new("RGBA", (args.frame_size + 2 * args.pad, args.frame_size + 2 * args.pad), (0, 0, 0, 0))
                padded.paste(final, (args.pad, args.pad), final)
                final = padded.resize((args.frame_size, args.frame_size), Image.Resampling.LANCZOS)
            
            final.save(dst, "PNG", optimize=True)
            if i == 1 or i % 8 == 0 or i == len(sources):
                print(f"  [{i}/{len(sources)}] {src.name} OK ({method})")
        except Exception as e:
            print(f"  [{i}/{len(sources)}] {src.name} FAILED to process: {e}", file=sys.stderr)
            
    print(f"✓ Done. Output: {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
