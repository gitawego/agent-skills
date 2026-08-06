---
name: android-compose-design-systems
description: Complete Android Jetpack Compose design-system library with three visual engines — pure neumorphism (Soft UI), glassmorphism (frosted glass), and the HyperOS dual-engine (neumorphic + glass with one-tap skin switching). Each engine ships a full theme (colors, typography, spacing, corner radii), convex/concave shadow and interaction Modifiers, core components (Button/Card/Switch/Slider/Input/Dialog), and adaptation rules for 40+ common controls. Make sure to use this skill whenever the user asks for neumorphism, neumorphic, soft UI, embossed or relief-style Android UI, glassmorphism, frosted glass, glass UI, translucent style UI, HyperOS or Xiaomi Pengpai style, "make my app look like MR-Linker", or wants a non-Material Android Compose component library — even if they don't name the style explicitly and just say things like "a soft raised login page", "a frosted settings screen", or "modern rounded cards with depth".
---

# Android Compose Design Systems

A collection of three complete **Android Jetpack Compose** design systems that replace the default Material look. Each one is a full UI kit — theme, interaction engine, core components, and 40+ extended controls — designed for new Compose projects.

| Engine | Reference | Look | Best for |
|--------|-----------|------|----------|
| **Neumorphism** (Soft UI) | `references/neumorphism.md` | Raised/sunken embossed surfaces, dual-tone shadows, borderless, minimal palette | Soft, tactile, "background-colored" apps — settings, dashboards, media players |
| **Glassmorphism** (frosted glass) | `references/glassmorphism.md` | Mesh light spots behind translucent tinted glass, gradient borders, inner highlights | Premium, airy, colorful apps — music, finance, weather, showcases |
| **Hyper-Neumorphic** (HyperOS) | `references/hyper-neumorphic.md` | Xiaomi HyperOS/Pengpai style; dual engine (neumorphic + glass) switchable at runtime | Xiaomi-style apps; or when you want BOTH styles behind one skin switch |

## How to use this skill

1. **Pick the engine** from the table above based on what the user asked for (see "Choosing an engine" below).
2. **Read the matching reference file** — it contains the full implementation, step by step: dependencies, theme files, component code, usage example, and design parameters.
3. Follow the **shared conventions** at the bottom of this file for haptics, extended controls, accessibility, and the things not to do.

When in doubt, `hyper-neumorphic` is the most complete reference implementation — the `neumorphism` and `glassmorphism` references use the same component APIs and only swap the underlying visual engine.

## Choosing an engine

Ask yourself what the user's words point at:

- **Neumorphism** — they say: "neumorphic", "soft UI", "embossed", "relief", "raised buttons", "sunken inputs", "no Material Design, softer look". The aesthetic is a surface that matches the background exactly, with soft shadows doing all the work.
- **Glassmorphism** — they say: "glass", "frosted", "毛玻璃", "translucent", "blur background", "see-through cards", "colorful ambient light". The aesthetic is transparency over a colorful mesh background — what you see *through* the glass matters.
- **Hyper-Neumorphic** — they say: "HyperOS", "Xiaomi", "Pengpai", "澎湃", "like MR-Linker", or they want a neumorphic app that can also switch to a glass look (the `LocalAppSkin` switch).
- **Multiple / unspecified** — if the user wants "a design system" without naming a style, build `hyper-neumorphic`: it is the superset and its components adapt to either skin.

All three engines share the same component vocabulary (see "Extended controls"), so you can swap engines without redesigning the UI.

## Shared setup

All three engines need the same dependencies:

```kotlin
// app/build.gradle.kts
dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.animation:animation")
}
```

And the same file layout under `ui/designsystem/` (package `com.example.app.designsystem`, adjust as needed):

```
ui/designsystem/
├── theme/       ← palette, typography, spacing, corner radii, shadow engine, root theme
├── token/       ← tap interactions (light/shadow linkage + scale + haptics)
└── component/   ← Button, Card, Switch, Slider, Input, Dialog + extended controls
```

## Shared conventions

### The core pattern: raised = default, sunken = pressed/selected/input

Every engine is built on a pair of surface Modifiers and a tap Modifier:

| Engine | Raised surface | Sunken surface | Tap |
|--------|----------------|----------------|-----|
| Neumorphism | `neumConvex` | `neumConcave` | `neumClickable` |
| Glassmorphism | `glassConvex` / `glassConvexOverlay` | `glassConcave` / `glassConcaveOverlay` | same `neumClickable` pattern |
| Hyper-Neumorphic | `neumorphicConvex` | `neumorphicConcave` | `neumorphicClickable` / `neumorphicTap` |

The state mapping is always the same:
- Default → raised (convex)
- Pressed / selected / focused / active input → sunken (concave), plus a small scale-down (0.95–0.96)
- Disabled → flat sunken at low elevation, content at ~30–48% alpha, no haptics

### Haptics

Every interactive component must trigger haptic feedback via `LocalHapticFeedback.current.performHapticFeedback(...)`:

| Component | Haptic type |
|------|------|
| Button / FAB / Checkbox / Radio / Chip / Tabs / ListItem | `TextHandleMove` |
| Switch | `LongPress` |
| Slider | `TextHandleMove` (at drag start + tap) |

### Extended controls

When building a real screen, cover these controls — don't ship a minimal Button/Card/Input set. All extended controls are built on the surface + tap Modifiers above, so they adapt to whichever engine is in use. API naming: `Neum*` for pure neumorphism, `Glass*` for pure glassmorphism, `Neumorphic*` for the hyper-neumorphic engine (parameters are isomorphic across engines for easy migration).

| Category | Controls |
|------|------|
| Actions | Button, IconButton, FAB, SplitButton, ToggleButton, SegmentedControl |
| Input | Input, PasswordInput, SearchBar, TextArea, Stepper, Slider, RangeSlider, RatingBar |
| Selection | Checkbox, RadioButton, Switch, Chip, DropdownMenu, DatePicker, TimePicker |
| Navigation | TopAppBar, Tabs, NavigationBar, NavigationRail, Breadcrumb, PagerIndicator |
| Display | Card, ListItem, GridTile, StatisticCard, Timeline, Avatar, Badge, Tag, Tooltip |
| Feedback | Dialog, BottomSheet, Snackbar, ToastHost, Progress, Spinner, Skeleton, EmptyState, ErrorState |
| Containers | Section, SettingsGroup, ExpandablePanel, Carousel, PullRefreshContainer |

Per-category visual rules (identical across engines):
- **Actions**: primary raised, concave when pressed; secondary lowers alpha, never adds Material elevation.
- **Input**: sunken container; focus shows an accent inner stroke; error changes text/border color only.
- **Numeric**: concave track + raised thumb; haptics when drag starts.
- **Selection**: selected = concave or accent fill; unselected = light raised.
- **Navigation**: current item raised/concave, unselected items distinguished by text color.
- **Display**: few container nests; small badges use low-alpha accent backgrounds.
- **Feedback**: standalone overlays (Dialog, BottomSheet, Snackbar, Dropdown, Tooltip) always use the `*Overlay` surface variants, which carry their own background in glass mode.
- **Containers**: no cards inside cards; express structure with spacing, indentation, and light dividers.

### Accessibility and states

- Pure icon actions must provide `contentDescription`; decorative icons pass `null`.
- Checkbox / Radio / Switch / Slider / Tab / Navigation items must expose the matching `semantics` (checked / selected / progress).
- Tap targets must be ≥ 44dp even when the visual is smaller (use `minimumInteractiveComponentSize()` or padding).
- Components should cover the relevant states of `enabled / loading / error / selected / focused / pressed`.
- Use `rememberSaveable` for inputs, tabs, and filters in example screens.

## Prohibitions (applies to all engines)

- **Never mix Material elevation with these systems** — no `ElevationCard`, no `Surface` elevation, no `ripple()` indication (`indication = null` everywhere).
- **Never overlay solid colors with `Modifier.background()` on a raised/sunken surface** — it destroys the embossed shadows or the glass translucency.
- **Use `detectTapGestures` + `pointerInput` for short-press animations**, not `MutableInteractionSource` (it lags on rapid taps). `Animatable.snapTo` handles the press instant, `animateTo` the release spring-back.
- **Keep elevations modest**: 6–8dp convex, 2–4dp concave is the sweet spot; excessive elevation looks muddy.
- **Glass specifics**: the root theme must wrap the app; surfaces must be `clip()`ped; `positionInWindow()` alignment is required for the mesh see-through; `tintConvex` ≤ 0.25.
- **Neumorphism specifics**: all raised/sunken surfaces must use the exact same background color.
- **One engine per screen** — don't mix neumorphism and glassmorphism (the hyper-neumorphic engine's runtime skin switch is the intended way to have both).

## After implementing

When you've built a screen with one of these systems, verify the result reads as the intended style:
- Embossed surfaces match the background color, no visible borders or ripples.
- Pressed states visibly sink (concave + scale) with haptics firing.
- Glass surfaces show the mesh through them and shift as they move.
- Every control has a state story (pressed / selected / disabled / loading where relevant).
