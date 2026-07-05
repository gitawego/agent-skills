# Animation Descriptions

This file documents the 8 default animation prompts and how to extend them.

## The 8 default animations

Each animation is described to `mmx image generate` in two parts:

1. **Static character description** (provided by the user via `--character`).
2. **Motion description** (one entry below — controlled by the script).

The motion description is appended verbatim to the per-row prompt. The script wraps the whole thing in a fixed template that already covers style ("Pure flat 2D anime cel shaded"), row layout (N sequential frames left-to-right), facing direction (right side profile), and background (solid magenta, no scenery, no ground, no shadows, no text, no labels, no frame boxes).

### IDLE — subtle bob

```
IDLE breathing cycle: subtle gentle up down bob, weight shifting from one
foot to other, robe and hood swaying slightly, head turning micro tilts,
six subtle idle poses with character nearly stationary
```

Use this for the resting animation. Six frames of "standing still but not frozen". The character should look alive but not move much. Godot users will typically loop this indefinitely between inputs.

### WALK — alternating stride

```
WALK cycle: legs alternating forward stride, opposite arm swinging in
counter rhythm, robe swaying side to side, six walking poses with clear
step pattern from left foot forward to right foot forward
```

Use for ground movement at normal speed. Arms swing opposite to legs (left arm forward when right leg forward). Robe/hood/hair should sway for momentum.

### RUN — leaning, faster, flowing

```
RUN cycle: character leaning forward with longer faster stride, hood and
robe flowing back behind body, both arms pumping, six running poses with
motion and energy
```

Body leans forward. Arms pump. Hood and robe flap backward. If your character has hair or accessories, they should stream back. Frame 3 or 4 of 6 should usually have both feet off the ground.

### ATTACK — wind-up + slash + follow-through

```
ATTACK cycle: wind up with raised right arm holding tombstone overhead,
then downward slash, then follow through, six attack poses from raise to
impact
```

Replace "tombstone" with whatever your character swings — sword, axe, fist, magic projectile. The six frames should span raise → overhead peak → downward arc → impact → recovery → ready. Don't bunch all six frames into the wind-up; the impact frame is critical for game feel.

### JUMP — crouch → leap → peak → fall → land

```
JUMP cycle: from crouch, push off ground, rising into air with tucked
legs at peak, then descending with legs extending for landing, six jump
poses through vertical arc
```

Vertical motion through the arc. Frame 1 crouches, frame 2-3 ascends (legs tucking), frame 4 peak (legs tucked), frame 5-6 descends (legs extending for landing). Empty ground visible under the airborne frames.

### HURT — knockback, X eyes, recoil

```
HURT cycle: knocked backward by impact, body recoils, X shaped glowing
purple eyes showing pain, body twisting back, hands up defensively, six
hurt reaction poses
```

This is the only animation where **glowing X-shaped eyes** are appropriate. The body should be recoiling away from the impact direction (right→left in our right-facing setup). Six frames is more than most games need; 2-3 frames is fine for a single "ouch" beat.

### DEATH — collapse

```
DEATH cycle: knees buckling, body collapsing sideways, falling to ground,
lying flat on back motionless, six death poses from standing collapse to
prone final pose
```

Six frames that visibly go from standing → buckling → falling → prone. The last frame should be a still pose that the game engine can hold on for several seconds.

### SPECIAL — magical cast

```
SPECIAL cast cycle: glowing purple magical aura radiating around character,
raised arms holding tombstone aloft, magical purple energy burst emanating
outward, six special casting poses with magical effects
```

The magical energy effect is what distinguishes this from ATTACK. The model tends to interpret "glowing purple aura" generously — accept whatever it draws. The energy burst on the last frame is usually the largest single shape in the entire sheet; this is fine, it will sit on the magenta background and key out cleanly.

## How the description format works

Each description follows three rules:

1. **Start with the animation name in CAPS.** This anchors the model's reading of the prompt. Don't bury it mid-sentence.
2. **Describe a sequence, not a single pose.** Use words like "cycle", "from X to Y", "six poses showing", "through vertical arc". The model needs to know you want motion, not a still portrait.
3. **Be concrete about pose changes.** "legs alternating forward" works better than "moving dynamically". "knees buckling then collapsing sideways then falling flat" works better than "falling down".

Don't say things like:
- "make it look good" — the model has no reference.
- "professional animation" — too vague.
- "exactly 6 frames" — the model can't count cells reliably. The script requests 6 in the wrapper; the model approximates.

## Adding a new animation

Two steps:

### 1. Add a case to `get_anim_description()` in the script

Open `scripts/mmx-sprite-sheet.sh` and add a new branch. Example for a `CROUCH` animation:

```bash
CROUCH)
  echo "CROUCH cycle: standing tall, knees bending, lowering into crouch, holding crouch, six poses showing the crouch down motion"
  ;;
```

Add it next to the other cases (alphabetical or grouped by category — pick one and stick with it).

### 2. Pass it via `--animations`

```bash
./scripts/mmx-sprite-sheet.sh \
  --character "..." \
  --animations IDLE,WALK,CROUCH,ATTACK,HURT,DEATH \
  --output ./tmp/stripped
```

The script will only generate the rows you list. The 8 defaults are a convenience, not a constraint.

## Built-in extras

The script ships three extras as commented-out starting points in the source. To enable them, copy a case into `get_anim_description()`:

```bash
CROUCH)
  echo "CROUCH cycle: standing tall, knees bending, lowering into crouch, holding crouch, six poses showing the crouch down motion"
  ;;
FALL)
  echo "FALL cycle: air poses with character falling downward, arms windmilling, robe flapping, six falling poses"
  ;;
BLOCK)
  echo "BLOCK cycle: arms crossed in defensive guard pose, shield up, slight body recoil, six blocking defensive poses"
  ;;
```

These cover common platformer / beat-'em-up animation needs. Add your own by following the same pattern.

## What doesn't work well

A few animation ideas that look intuitive but produce bad results in diffusion models:

- **Multi-character scenes** ("character attacks an enemy"). Diffusion can't reliably produce two distinct characters in a sequence. If you need attack VFX, render them as part of your character and key out the enemy.
- **Heavy perspective shifts** ("camera zooms in"). The model can't change the camera between frames; it just gives you six identical-scale poses that look like a billboard.
- **Particle-only frames** ("frames 4-6 are just sparks, no character"). The model always centers a character figure; an empty cell confuses it.
- **Weapon swaps** ("frames 1-3 no weapon, frames 4-6 sword drawn"). The model prefers one consistent weapon across all six frames. If you want a "draw sword" animation, do it as a smooth motion in the same weapon state.

If you need any of these, render them as separate cells and composite manually — this skill won't get you there.