---
name: sprites-sheet-creator
description: Generate 2D game character animation sprite sheets and extract/align individual frames for Godot. Supports native Gemini image generation (Gemini Banana) or mmx-cli, and complex multi-row layouts.
---

# Sprites Sheet Creator Skill

Use this skill to generate high-quality 2D game character animations and automatically slice them into individual normalized frames for Godot.

## Workflow

### 1. User Choice & Configuration
Before starting the generation, ask the user to clarify:
1. **Generation Tool**: `gemini` (default, native image generation) or `mmx-cli` (using the MiniMax CLI).
2. **Animations**: The list of animations to create (defaults to: `IDLE, WALK, RUN, ATTACK, JUMP, HURT, DEATH, SPECIAL`).
3. **Character Description**: A detailed description of the character (visual traits, colors, clothing, weapons).

---

### 2. Image Generation Guidelines

When using **Gemini (Native)**:
* Call the `generate_image` tool using an aspect ratio of `16:9`.
* For each animation, use a structured prompt:
  ```
  Pure flat 2D game art cel-shaded horizontal sprite strip. 6 sequential figures arranged side-by-side in a single horizontal row from left to right. There is only one single row of figures, no other rows, no vertical stacking. [CHARACTER_DESCRIPTION]. Cel-shaded 2D game art cel-shaded style with bold dark outlines. Strictly side profile facing right. Identical scale and design across all 6 figures. Pure solid blue #0000FF background filling all empty space. 6 poses showing a [ANIMATION_TYPE] cycle: [ANIMATION_SPECIFIC_MOTION_DETAILS].
  ```

#### Critical Prompt Optimizations:
* **Walk Cycles**: To prevent identical standing poses, explicitly describe the legs crossing progression for all 6 poses:
  > *"6 walking poses showing a walking cycle progression: Pose 1 shows right leg forward and left leg back stride. Pose 2 shows feet crossing with left foot off the ground. Pose 3 shows left leg forward and right leg back stride. Pose 4 shows left leg forward and right leg back stride. Pose 5 shows feet crossing with right foot off the ground. Pose 6 shows right leg forward and left leg back stride."*
* **Attack Animations**: To prevent weapons/tools from disappearing, explicitly enforce that the item is held:
  > *"In every single pose, the character is holding [weapon/item name] in its right hand. Poses showing: winding up weapon, lunging forward striking, overhead swing, slamming it down, recovering."*
* **Multi-Row Grid Layouts**: If the diffusion model folds a sequence into multiple rows (e.g. 2x3 or 2-row layout), use the **Custom Manifest Configuration** (see section 4) to manually index the poses instead of trying to force a single-row regeneration.

---

### 3. Extraction & Alignment
Once the raw row images are available under `assets_raw/characters/[character_name]/raw/`, execute the Python extractor script. It performs:
1. **Chroma-Key**: Removes the solid blue background using NumPy mask thresholding.
2. **Isolate Components**: Applies connected component labeling (`scipy.ndimage.label`) to find the exact 2D boundaries of the characters, ignoring stamp labels.
3. **Alpha Masking**: Masks out pixels belonging to neighboring frames (preventing label bleeding or adjacent limb overlapping).
4. **Global Uniform Scaling**: Calculates the global maximum height and width across all frames and scales them uniformly to fit inside a `230px` box (preventing scaling jitter/breathing).
5. **Ground Alignment**: Centers each frame horizontally and aligns it vertically relative to the ground baseline (`Y = 254`) on a `256x256` canvas.

---

### 4. Custom Manifest Configuration (`extract_config.json`)
For complex sheets (multi-row layout, custom frame counts, or floating particle/swing arc effects that get split into multiple components), place a JSON file named `extract_config.json` inside the raw image directory.

#### Example Config:
```json
{
  "target_fit": 230,
  "ground_y": 254,
  "animations": {
    "WALK": {
      "frames": ["a", "b", "c", "d"]
    },
    "DEATH": {
      "frames": ["a", "b", "c", "d", "e", "f"],
      "custom_components": [
        [1],       
        [2],       
        [3],       
        [4],       
        [9],       
        [10]       
      ]
    },
    "ATTACK": {
      "frames": ["a", "b", "c", "d", "e", "f"],
      "custom_components": [
        [12],              
        [14],              
        [6, 1, 8],         
        [11, 85, 90],      
        [109],             
        [112]              
      ]
    }
  }
}
```
* **`frames`**: Declares the frame key suffix list, allowing you to easily configure animations with fewer than 6 frames (e.g. 4 frames for WALK).
* **`custom_components`**: Lists of connected component indices to extract for each frame. This is extremely useful for:
  - Specifying the exact poses in multi-row sheets (ignoring duplicates).
  - Merging character components with detached effects like swing arcs or impact dust (e.g. merging components `6, 1, 8` into frame `c`).

---

### 5. Running the Extractor
To slice the frames, run:
```bash
python3 -m scripts.direct_extract --raw-dir assets_raw/characters/[name]/raw --out-dir assets/characters/[name]
```
The sliced PNG frames will be saved directly into `assets/characters/[character_name]/[animation]/[animation]_[key].png` where the Godot engine expects them.
