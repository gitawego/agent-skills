#!/usr/bin/env python3
"""Direct extraction script for sprites-sheet-creator skill.

Extracts, chroma-keys, masks, scales, and aligns animation frames directly from raw row JPEGs/PNGs.
Supports manifest files for complex multi-row and custom component layouts.
"""

import argparse
import json
import sys
from pathlib import Path
import numpy as np
import scipy.ndimage
from PIL import Image

CANVAS_W = 256
CANVAS_H = 256
DEFAULT_FRAMES = ["a", "b", "c", "d", "e", "f"]

# Default animations mapping
DEFAULT_CONFIG = {
    "IDLE": ("idle", DEFAULT_FRAMES),
    "WALK": ("walk", DEFAULT_FRAMES),
    "RUN": ("run", DEFAULT_FRAMES),
    "ATTACK": ("attack", DEFAULT_FRAMES),
    "JUMP": ("jump", DEFAULT_FRAMES),
    "HURT": ("hurt", DEFAULT_FRAMES),
    "DEATH": ("death", DEFAULT_FRAMES),
    "SPECIAL": ("special", DEFAULT_FRAMES),
}

def chroma_key_blue(img, tolerance=100):
    """Chroma-keys out pure blue (#0000FF) background to transparent alpha."""
    rgba = img.convert("RGBA")
    arr = np.array(rgba)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    
    # Blue background mask: Blue value is significantly higher than Red and Green
    blue_mask = (b.astype(int) - r.astype(int) > tolerance) & (b.astype(int) - g.astype(int) > tolerance)
    arr[blue_mask, 3] = 0
    return Image.fromarray(arr)

def get_row_frames_auto(row_img, label_width=240, num_frames=6):
    """Finds the bounding boxes of the character frames using connected component analysis.
    Slices horizontally into `num_frames` columns.
    """
    r_w, r_h = row_img.size
    arr = np.array(row_img)
    alpha = arr[:, :, 3]
    
    # Create mask for character region
    mask = np.zeros_like(alpha, dtype=bool)
    mask[:, label_width:] = alpha[:, label_width:] > 0
    
    # Connected component labeling
    labeled, num_features = scipy.ndimage.label(mask)
    
    # Group components by their column region
    frame_w = (r_w - label_width) // num_frames
    frame_groups = {i: [] for i in range(num_frames)}
    
    for i in range(1, num_features + 1):
        rows, cols = np.where(labeled == i)
        if len(rows) > 0 and len(cols) > 0:
            x_min, x_max = cols.min(), cols.max()
            y_min, y_max = rows.min(), rows.max()
            
            # Ignore extremely small noise components
            if (x_max - x_min + 1) * (y_max - y_min + 1) < 16:
                continue
            
            # Find horizontal center
            x_center = (x_min + x_max) / 2.0
            
            # Map center to frame column index
            frame_idx = int((x_center - label_width) / frame_w)
            if frame_idx < 0:
                frame_idx = 0
            elif frame_idx >= num_frames:
                frame_idx = num_frames - 1
                
            frame_groups[frame_idx].append((i, x_min, y_min, x_max, y_max))
            
    frame_boxes = []
    for i in range(num_frames):
        components = frame_groups[i]
        if len(components) > 0:
            x_min = min(c[1] for c in components)
            y_min = min(c[2] for c in components)
            x_max = max(c[3] for c in components)
            y_max = max(c[4] for c in components)
            comp_ids = [c[0] for c in components]
            frame_boxes.append((x_min, y_min, x_max, y_max, comp_ids))
        else:
            frame_boxes.append(None)
            
    return frame_boxes, labeled

def get_row_frames_custom(labeled_mask, custom_components):
    """Computes bounding boxes for frames based on manual component lists."""
    frame_boxes = []
    for comp_ids in custom_components:
        all_rows, all_cols = [], []
        for cid in comp_ids:
            rows, cols = np.where(labeled_mask == cid)
            if len(rows) > 0:
                all_rows.extend(rows)
                all_cols.extend(cols)
        if all_rows:
            x_min, y_min, x_max, y_max = min(all_cols), min(all_rows), max(all_cols), max(all_rows)
            frame_boxes.append((x_min, y_min, x_max, y_max, comp_ids))
        else:
            frame_boxes.append(None)
    return frame_boxes

def extract_character(args):
    raw_dir = Path(args.raw_dir)
    out_dir = Path(args.out_dir)
    
    # Load manifest if available
    manifest = {}
    manifest_path = raw_dir / "extract_config.json"
    if manifest_path.exists():
        try:
            with open(manifest_path, "r") as f:
                manifest = json.load(f)
            print(f"Loaded extraction config manifest from {manifest_path.name}")
        except Exception as e:
            print(f"WARNING: Failed to parse manifest {manifest_path.name}: {e}")

    # Override arguments from manifest if present
    ground_y = manifest.get("ground_y", args.ground_y)
    max_dim = manifest.get("max_dim", args.max_dim)
    tolerance = manifest.get("tolerance", args.tolerance)
    label_width = manifest.get("label_width", args.label_width)
    
    # Resolve frame config mapping
    anim_config = {}
    for action, default_val in DEFAULT_CONFIG.items():
        anim_data = manifest.get("animations", {}).get(action, {})
        folder_name = anim_data.get("folder", default_val[0])
        frame_keys = anim_data.get("frames", default_val[1])
        anim_config[action] = {
            "folder": folder_name,
            "frames": frame_keys,
            "custom_components": anim_data.get("custom_components", None),
            "label_width": anim_data.get("label_width", label_width),
            "ground_y": anim_data.get("ground_y", ground_y)
        }
    
    # Identify which actions we have raw images for
    actions_to_process = []
    for action in anim_config.keys():
        for ext in ["jpg", "png", "jpeg"]:
            src_path = raw_dir / f"{action}.{ext}"
            if src_path.exists():
                actions_to_process.append((action, src_path))
                break
                
    if not actions_to_process:
        print(f"ERROR: No raw images found under {raw_dir}. Make sure files are named IDLE.jpg, WALK.jpg, etc.")
        sys.exit(1)
        
    print(f"Found {len(actions_to_process)} raw animation strips to process.")
    
    # Pass 1: Chroma-key and find global maximum character dimensions
    processed_rows = {}
    global_max_h = 0
    global_max_w = 0
    
    for action, src_path in actions_to_process:
        print(f"Reading {src_path.name}...")
        img = Image.open(src_path)
        trans_img = chroma_key_blue(img, tolerance)
        
        # Connected components on transparent image
        arr = np.array(trans_img)
        labeled, num_features = scipy.ndimage.label(arr[:, :, 3] > 0)
        
        cfg = anim_config[action]
        custom_mapping = cfg["custom_components"]
        
        if custom_mapping is not None:
            print(f"  Using custom component mapping ({len(custom_mapping)} frames)...")
            boxes = get_row_frames_custom(labeled, custom_mapping)
        else:
            num_cols = len(cfg["frames"])
            lw = cfg["label_width"]
            boxes, _ = get_row_frames_auto(trans_img, lw, num_cols)
            
        processed_rows[action] = (trans_img, boxes, labeled)
        
        # Update global max dimensions
        for box in boxes:
            if box is not None:
                x_min, y_min, x_max, y_max, _ = box
                w = x_max - x_min + 1
                h = y_max - y_min + 1
                if h > global_max_h:
                    global_max_h = h
                if w > global_max_w:
                    global_max_w = w

    if global_max_h == 0 or global_max_w == 0:
        print("ERROR: No character components found after chroma-keying.")
        sys.exit(1)
        
    # Calculate scale factor
    scale_factor = min(max_dim / global_max_h, max_dim / global_max_w)
    print(f"Global max character size: {global_max_w}x{global_max_h}")
    print(f"Applying scale factor: {scale_factor:.4f} (Target fit: {max_dim})")
    
    # Pass 2: Extract, mask, scale, and save
    out_dir.mkdir(parents=True, exist_ok=True)
    
    for action, (trans_img, boxes, labeled) in processed_rows.items():
        cfg = anim_config[action]
        anim_name = cfg["folder"]
        default_keys = cfg["frames"]
        anim_out_dir = out_dir / anim_name
        anim_out_dir.mkdir(parents=True, exist_ok=True)
        
        # Find local ground baseline coordinate (max Y bottom across base frames)
        max_bottom = 0
        # If custom mapping exists, align relative to first few base frames
        num_align_frames = min(4, len(boxes))
        for idx in range(num_align_frames):
            box = boxes[idx]
            if box is not None:
                y_max = box[3]
                if y_max > max_bottom:
                    max_bottom = y_max
        if max_bottom == 0:
            max_bottom = trans_img.height - 10
            
        # Extract frames
        for i, key in enumerate(default_keys):
            if i >= len(boxes):
                break
            box = boxes[i]
            canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
            
            if box is not None:
                x_min, y_min, x_max, y_max, comp_ids = box
                w = x_max - x_min + 1
                h = y_max - y_min + 1
                
                # Mask out other connected components
                mask_frame = np.zeros_like(labeled, dtype=bool)
                for comp_id in comp_ids:
                    mask_frame = mask_frame | (labeled == comp_id)
                    
                feat_arr = np.array(trans_img)
                feat_arr[~mask_frame, 3] = 0
                feat_img = Image.fromarray(feat_arr)
                
                # Crop
                crop = feat_img.crop((x_min, y_min, x_max + 1, y_max + 1))
                
                # Resize
                new_w = int(w * scale_factor)
                new_h = int(h * scale_factor)
                if new_w > 0 and new_h > 0:
                    crop = crop.resize((new_w, new_h), Image.Resampling.LANCZOS)
                    
                # Position
                cx = (CANVAS_W - new_w) // 2
                
                # If custom mapping is used, indices past base poses can lie flat on ground
                is_grounded_pose = (cfg["custom_components"] is not None and i >= 4 and action == "DEATH")
                
                if is_grounded_pose:
                    cy = cfg["ground_y"] - new_h
                else:
                    dy = max_bottom - y_max
                    scaled_dy = int(dy * scale_factor)
                    cy = cfg["ground_y"] - scaled_dy - new_h
                
                if cy < 0:
                    cy = 0
                canvas.alpha_composite(crop, (cx, cy))
                
            out_path = anim_out_dir / f"{anim_name}_{key}.png"
            canvas.save(out_path, "PNG")
            print(f"  Saved {out_path.relative_to(out_dir.parent)}")
            
    print("Frame extraction and normalization complete.")

def main():
    parser = argparse.ArgumentParser(description="Directly extract, chroma-key, and align game frames.")
    parser.add_argument("--raw-dir", required=True, help="Directory containing raw row JPEGs/PNGs")
    parser.add_argument("--out-dir", required=True, help="Target directory for output transparent frames")
    parser.add_argument("--tolerance", type=int, default=100, help="Blue chroma-key color distance tolerance")
    parser.add_argument("--label-width", type=int, default=240, help="Width of the gutter margin on the left")
    parser.add_argument("--ground-y", type=int, default=254, help="Target ground baseline coordinate")
    parser.add_argument("--max-dim", type=int, default=230, help="Maximum height or width of characters on canvas")
    
    args = parser.parse_args()
    extract_character(args)

if __name__ == "__main__":
    main()
