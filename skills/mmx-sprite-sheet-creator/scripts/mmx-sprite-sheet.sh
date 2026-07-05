#!/usr/bin/env bash
#
# mmx-sprite-sheet.sh — generate a transparent game sprite sheet from a
# character description, using the mmx CLI and ImageMagick.
#
# Usage:
#   ./mmx-sprite-sheet.sh --character "<desc>" [--output DIR] [--animations A,B,C] ...
#
# See SKILL.md for full docs, or ./mmx-sprite-sheet.sh --help for flags.

set -euo pipefail

# ----------------------------------------------------------------------------
# Defaults
# ----------------------------------------------------------------------------

CHARACTER=""
OUTPUT="./tmp/sprite_sheet"
ANIMATIONS="IDLE,WALK,RUN,ATTACK,JUMP,HURT,DEATH,SPECIAL"
FRAMES=6
VARIATIONS=2
SEED=700002
LABEL_WIDTH=240
ROW_HEIGHT=720
GAP=24
BOTTOM_PAD=100
KEEP_RAW=0
DRY_RUN=0

MAGENTA="#FF00FF"
ROW_WIDTH=1280
FUZZ=35

# ----------------------------------------------------------------------------
# get_anim_description <ACTION>
#
# Returns the animation-specific motion description that gets appended to the
# per-row prompt. The character description and the standard "no scenery, no
# ground" wrapper come from the prompt template in main(); this function only
# supplies the motion vocabulary for the named animation.
#
# To add a new animation, add a new case here AND mention it in
# references/animations.md so the doc stays in sync.
# ----------------------------------------------------------------------------
get_anim_description() {
  case "$1" in
    IDLE)
      echo "IDLE breathing cycle: subtle gentle up down bob, weight shifting from one foot to other, robe and hood swaying slightly, head turning micro tilts, six subtle idle poses with character nearly stationary"
      ;;
    WALK)
      echo "WALK cycle: legs alternating forward stride, opposite arm swinging in counter rhythm, robe swaying side to side, six walking poses with clear step pattern from left foot forward to right foot forward"
      ;;
    RUN)
      echo "RUN cycle: character leaning forward with longer faster stride, hood and robe flowing back behind body, both arms pumping, six running poses with motion and energy"
      ;;
    ATTACK)
      echo "ATTACK cycle: wind up with raised right arm holding tombstone overhead, then downward slash, then follow through, six attack poses from raise to impact"
      ;;
    JUMP)
      echo "JUMP cycle: from crouch, push off ground, rising into air with tucked legs at peak, then descending with legs extending for landing, six jump poses through vertical arc"
      ;;
    HURT)
      echo "HURT cycle: knocked backward by impact, body recoils, X shaped glowing purple eyes showing pain, body twisting back, hands up defensively, six hurt reaction poses"
      ;;
    DEATH)
      echo "DEATH cycle: knees buckling, body collapsing sideways, falling to ground, lying flat on back motionless, six death poses from standing collapse to prone final pose"
      ;;
    SPECIAL)
      echo "SPECIAL cast cycle: glowing purple magical aura radiating around character, raised arms holding tombstone aloft, magical purple energy burst emanating outward, six special casting poses with magical effects"
      ;;
    CROUCH)
      echo "CROUCH cycle: standing tall, knees bending, lowering into crouch, holding crouch, six poses showing the crouch down motion"
      ;;
    FALL)
      echo "FALL cycle: air poses with character falling downward, arms windmilling, robe flapping, six falling poses"
      ;;
    BLOCK)
      echo "BLOCK cycle: arms crossed in defensive guard pose, shield up, slight body recoil, six blocking defensive poses"
      ;;
    *)
      echo "ERROR: unknown animation '$1'. Add it to get_anim_description() in $0." >&2
      return 1
      ;;
  esac
}

# ----------------------------------------------------------------------------
# Argument parsing
# ----------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage: $0 --character "<text>" [options]

REQUIRED
  --character <text>       Character description (multi-line ok). Inserted
                           verbatim into every per-row prompt.

OPTIONS
  --output <dir>           Output directory. Default: ./tmp/sprite_sheet
  --animations <list>      Comma-separated actions. Default: IDLE,WALK,RUN,
                           ATTACK,JUMP,HURT,DEATH,SPECIAL
  --frames <n>             Frames per row (prompt-only; model decides actual).
                           Default: 6
  --variations <n>         mmx images generated per row. Default: 2
  --seed <n>               Same seed for every row. Default: 700002
  --label-width <px>       White label gutter width. Default: 240
  --row-height <px>        Each row's pixel height. Default: 720
  --gap <px>               Vertical transparent gap between rows. Default: 24
  --bottom-pad <px>        Transparent padding below the last row. Default: 100
  --keep-raw               Don't delete raw downloaded JPEGs.
  --dry-run                Print what would be done without calling mmx.
  -h | --help              This message.

Outputs in <output-dir>:
  sprite_sheet.png         full labeled sheet, transparent RGBA
  sprite_sheet_preview.png checkerboard preview
  sprite_sheet.json        manifest of cell coords
  rows/<ACTION>.png        transparent labeled row per animation
  raw/                     raw mmx downloads (kept if --keep-raw)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --character) CHARACTER="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --animations) ANIMATIONS="$2"; shift 2 ;;
    --frames) FRAMES="$2"; shift 2 ;;
    --variations) VARIATIONS="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    --label-width) LABEL_WIDTH="$2"; shift 2 ;;
    --row-height) ROW_HEIGHT="$2"; shift 2 ;;
    --gap) GAP="$2"; shift 2 ;;
    --bottom-pad) BOTTOM_PAD="$2"; shift 2 ;;
    --keep-raw) KEEP_RAW=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$CHARACTER" ]]; then
  echo "ERROR: --character is required." >&2
  usage
  exit 1
fi

# ----------------------------------------------------------------------------
# Sanity
# ----------------------------------------------------------------------------

if [[ "$DRY_RUN" -eq 0 ]]; then
  command -v mmx >/dev/null 2>&1 || { echo "ERROR: mmx not on PATH. Run: npm install -g mmx-cli && mmx auth login --api-key ..." >&2; exit 1; }
  command -v magick >/dev/null 2>&1 || { echo "ERROR: ImageMagick 'magick' not on PATH." >&2; exit 1; }
  command -v bc >/dev/null 2>&1 || { echo "ERROR: 'bc' not on PATH." >&2; exit 1; }

  if ! mmx auth status >/dev/null 2>&1; then
    echo "ERROR: mmx not authenticated. Run: mmx auth login --api-key sk-..." >&2
    exit 1
  fi
fi

# ----------------------------------------------------------------------------
# Setup
# ----------------------------------------------------------------------------

mkdir -p "$OUTPUT/raw" "$OUTPUT/rows"
SHEET_WIDTH=$((ROW_WIDTH + LABEL_WIDTH))
PROMPT_PREFIX="Pure flat 2D anime cel shaded horizontal sprite strip. ${FRAMES} sequential frames left to right of the SAME character: ${CHARACTER}. Identical scale and design across all ${FRAMES} frames, all facing right side profile. Pure solid magenta ${MAGENTA} background edge to edge filling all empty space, no scenery, no ground, no floor, no shadows on background, no text, no labels, no frame boxes. ${FRAMES} poses evenly spaced left to right with small magenta padding between frames. "
PROMPT_SUFFIX="."

IFS=',' read -ra ACTIONS <<<"$ANIMATIONS"

# Validate every requested animation before any mmx call.
for ACTION in "${ACTIONS[@]}"; do
  if ! get_anim_description "$ACTION" >/dev/null 2>&1; then
    echo "ERROR: unknown animation '$ACTION'. Add it to get_anim_description() in $0." >&2
    exit 1
  fi
done

echo "==> ${#ACTIONS[@]} animation rows × ${VARIATIONS} variations = $(( ${#ACTIONS[@]} * VARIATIONS )) mmx calls"
echo "==> Output: $OUTPUT"
echo "==> Sheet canvas: ${SHEET_WIDTH} × ($(( ${#ACTIONS[@]} * ROW_HEIGHT + (${#ACTIONS[@]} - 1) * GAP + BOTTOM_PAD )) pixels)"
echo

# ----------------------------------------------------------------------------
# Stage 1: generate per-row raw images via mmx
# ----------------------------------------------------------------------------

for ACTION in "${ACTIONS[@]}"; do
  ANIM_DESC="$(get_anim_description "$ACTION")"
  PROMPT="${PROMPT_PREFIX}${ANIM_DESC}${PROMPT_SUFFIX}"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    ELEN=$(echo -n "$PROMPT" | wc -c)
    echo "[dry-run] mmx image generate for ${ACTION}: prompt=${ELEN} chars"
    continue
  fi

  echo "==> Generating ${ACTION}..."
  # mmx --out-prefix + --out-dir saves <prefix>_001.jpg, _002.jpg, ...
  # We delete extras after the call (keep the first).
  PREFIX="row_${ACTION}_"
  OUT_PREFIX_DIR="${OUTPUT}/raw"
  mmx image generate \
    --prompt "$PROMPT" \
    --width "$ROW_WIDTH" --height "$ROW_HEIGHT" \
    --seed "$SEED" \
    --n "$VARIATIONS" \
    --out-dir "$OUT_PREFIX_DIR" \
    --out-prefix "$PREFIX" \
    --quiet >/dev/null

  # Rename the first surviving file to row_<ACTION>.jpg for easy handling
  FIRST=$(ls "$OUT_PREFIX_DIR"/${PREFIX}*.{jpg,jpeg,png} 2>/dev/null | head -1 || true)
  if [[ -z "$FIRST" ]]; then
    echo "ERROR: mmx produced no output for ${ACTION}" >&2
    exit 1
  fi
  mv "$FIRST" "$OUTPUT/raw/${ACTION}.jpg"
done

# Remove extra variations
if [[ "$DRY_RUN" -eq 0 ]]; then
  for ACTION in "${ACTIONS[@]}"; do
    # Remove any leftover row_<ACTION>_NNN files (we kept just <ACTION>.jpg)
    find "$OUTPUT/raw" -maxdepth 1 -name "${ACTION}_*.jpg" -delete 2>/dev/null || true
    find "$OUTPUT/raw" -maxdepth 1 -name "${ACTION}_*.jpeg" -delete 2>/dev/null || true
    find "$OUTPUT/raw" -maxdepth 1 -name "${ACTION}_*.png" -delete 2>/dev/null || true
  done
fi

# ----------------------------------------------------------------------------
# Stage 2: build labeled rows (white gutter + raw image + label text)
# ----------------------------------------------------------------------------

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] would build labeled rows"
  exit 0
fi

for ACTION in "${ACTIONS[@]}"; do
  SRC="$OUTPUT/raw/${ACTION}.jpg"
  DST="$OUTPUT/rows/${ACTION}.png"
  if [[ ! -f "$SRC" ]]; then
    echo "ERROR: missing raw image for ${ACTION}: $SRC" >&2
    exit 1
  fi

  # Normalize source to exactly ROW_WIDTH × ROW_HEIGHT
  NORM="$OUTPUT/raw/_norm_${ACTION}.png"
  magick "$SRC" -resize "${ROW_WIDTH}x${ROW_HEIGHT}!" "$NORM"

  # White gutter
  magick -size "${LABEL_WIDTH}x${ROW_HEIGHT}" xc:white "$OUTPUT/raw/_gutter_${ACTION}.png"

  # Magenta base
  magick -size "${SHEET_WIDTH}x${ROW_HEIGHT}" xc:"$MAGENTA" "$OUTPUT/raw/_base_${ACTION}.png"

  # Composite gutter on the left
  magick "$OUTPUT/raw/_base_${ACTION}.png" "$OUTPUT/raw/_gutter_${ACTION}.png" -geometry +0+0 -composite "$OUTPUT/raw/_base_${ACTION}.png"

  # Composite character strip on the right
  magick "$OUTPUT/raw/_base_${ACTION}.png" "$NORM" -geometry +${LABEL_WIDTH}+0 -composite "$OUTPUT/raw/_base_${ACTION}.png"

  # Stamp label
  magick "$OUTPUT/raw/_base_${ACTION}.png" \
    -font DejaVu-Sans-Bold -pointsize 56 -fill black \
    -gravity West -annotate +20+0 "${ACTION}" \
    "$DST"
done

# ----------------------------------------------------------------------------
# Stage 3: stack rows vertically with magenta gaps, add bottom pad
# ----------------------------------------------------------------------------

STACK_HEIGHT=$(( ${#ACTIONS[@]} * ROW_HEIGHT + (${#ACTIONS[@]} - 1) * GAP ))
FINAL_HEIGHT=$(( STACK_HEIGHT + BOTTOM_PAD ))
echo "==> Stacking into ${SHEET_WIDTH} × ${FINAL_HEIGHT}"

magick -size "${SHEET_WIDTH}x${FINAL_HEIGHT}" xc:"$MAGENTA" "$OUTPUT/raw/_stack.png"

OFFSET=0
for ACTION in "${ACTIONS[@]}"; do
  if [[ "$OFFSET" -gt 0 ]]; then
    OFFSET=$(( OFFSET + GAP ))
  fi
  magick "$OUTPUT/raw/_stack.png" "$OUTPUT/rows/${ACTION}.png" -geometry +0+${OFFSET} -composite "$OUTPUT/raw/_stack.png"
  OFFSET=$(( OFFSET + ROW_HEIGHT ))
done

# ----------------------------------------------------------------------------
# Stage 4: chroma-key magenta → transparent
# ----------------------------------------------------------------------------

echo "==> Chroma-key (fuzz=${FUZZ}%)..."
magick "$OUTPUT/raw/_stack.png" \
  -fuzz "${FUZZ}%" -transparent "$MAGENTA" \
  -define png:color-type=6 \
  "$OUTPUT/sprite_sheet.png"

# ----------------------------------------------------------------------------
# Stage 5: split per-row transparent PNGs (already labeled, just re-keyed)
# ----------------------------------------------------------------------------

# Each rows/<ACTION>.png still has a magenta right side; re-key.
for ACTION in "${ACTIONS[@]}"; do
  magick "$OUTPUT/rows/${ACTION}.png" \
    -fuzz "${FUZZ}%" -transparent "$MAGENTA" \
    -define png:color-type=6 \
    "$OUTPUT/rows/${ACTION}.png"
done

# ----------------------------------------------------------------------------
# Stage 6: write JSON manifest
# ----------------------------------------------------------------------------

FRAME_W=$(echo "${ROW_WIDTH}/${FRAMES}" | bc)
MANIFEST="$OUTPUT/sprite_sheet.json"
{
  echo "{"
  echo "  \"sheet\": \"sprite_sheet.png\","
  echo "  \"canvas\": { \"width\": ${SHEET_WIDTH}, \"height\": ${FINAL_HEIGHT} },"
  echo "  \"label_width\": ${LABEL_WIDTH},"
  echo "  \"frame_size\": { \"width\": ${FRAME_W}, \"height\": ${ROW_HEIGHT} },"
  echo "  \"gap\": ${GAP},"
  echo "  \"bottom_pad\": ${BOTTOM_PAD},"
  echo "  \"rows\": {"
  OFFSET=0
  FIRST=1
  for ACTION in "${ACTIONS[@]}"; do
    if [[ "$FIRST" -eq 0 ]]; then echo ","; fi
    FIRST=0
    printf "    \"%s\": { \"y_offset\": %d, \"frames\": %d, \"file\": \"rows/%s.png\" }" \
      "$ACTION" "$OFFSET" "$FRAMES" "$ACTION"
    OFFSET=$(( OFFSET + ROW_HEIGHT + GAP ))
  done
  echo
  echo "  }"
  echo "}"
} > "$MANIFEST"

# ----------------------------------------------------------------------------
# Stage 7: checkerboard preview
# ----------------------------------------------------------------------------

CHECKER="$OUTPUT/raw/_checker.png"
magick -size "${SHEET_WIDTH}x${FINAL_HEIGHT}" pattern:checkerboard "$CHECKER"
magick "$CHECKER" "$OUTPUT/sprite_sheet.png" -composite "$OUTPUT/sprite_sheet_preview.png"

# ----------------------------------------------------------------------------
# Cleanup intermediates unless --keep-raw
# ----------------------------------------------------------------------------

if [[ "$KEEP_RAW" -eq 0 ]]; then
  rm -rf "$OUTPUT/raw"
fi

echo
echo "==> Done."
echo "    Sheet:  $OUTPUT/sprite_sheet.png"
echo "    Preview:$OUTPUT/sprite_sheet_preview.png"
echo "    Manifest: $OUTPUT/sprite_sheet.json"
echo "    Rows:   $OUTPUT/rows/*.png"