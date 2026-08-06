---
name: glassmorphism
description: Glassmorphism / frosted glass design system — a complete Android Jetpack Compose UI kit. Frosted glass effects: multi-layer radial-gradient Mesh backgrounds, semi-transparent tint overlays, gradient borders, top inner highlights, soft outer shadows. Includes light/dark glass token sets, raised/sunken glass surface Modifiers, glass buttons/cards/inputs/dialogs, and glass adaptation rules for SearchBar/NavigationBar/BottomSheet/DatePicker and other common controls.
---

# Glassmorphism — Frosted Glass Design System

An Android Jetpack Compose glassmorphism / frosted-glass design system. Multi-layer radial-gradient Mesh backgrounds + semi-transparent tint overlays + gradient borders + inner highlights produce translucent, deep frosted-glass surfaces.

## Design characteristics

- **Mesh multi-layer light-spot background**: 4-5 radial gradient spots (varied positions/colors/alpha) simulating the colorful ambient light seen through glass
- **Mesh-aligned see-through**: each glass surface uses `positionInWindow()` to precisely align with the global mesh — as a card moves, the spots showing through shift with it
- **Semi-transparent tint**: `tintConvex` (light white) for raised surfaces, `tintConcave` (dark) for sunken surfaces
- **Gradient border**: `borderHi`/`borderLo` 1dp top-to-bottom gradient border simulating glass edge reflection
- **Top inner highlight**: 1dp white highlight line at the card top simulating light-source reflection
- **Soft outer shadow**: only a thin shadow line below, light and unobtrusive
- **Light/dark token sets**: `DefaultGlassTokens` (vivid dark) and `LightGlassTokens` (translucent milky white)

## Design philosophy

Glassmorphism is not just "blur + transparency". The core is **"what you see through the glass"** — the mesh spots simulate the colorful ambient light behind the glass scattering across the frosted surface. When cards move, the aligned mesh lets each surface reveal different spot regions, creating the illusion of "glass thickness" and "spatial depth".

## When to use

- **New Android Jetpack Compose project**
- The user asks for "frosted glass style" / "glassmorphism" / "translucent UI" / "frosted glass"

## File structure

```
ui/designsystem/
├── theme/
│   ├── GlassTokens.kt      ← Glass tokens (mesh spots + tint colors + border colors + text colors)
│   ├── GlassMesh.kt         ← Mesh background + glass surface Modifiers
│   ├── GlassColors.kt       ← Accent palette
│   ├── GlassTypography.kt   ← Typography
│   └── GlassTheme.kt        ← Root theme (integrates mesh background)
└── component/
    ├── GlassButton.kt       ← Glass button
    ├── GlassCard.kt         ← Glass card
    ├── GlassInput.kt        ← Glass input field
    ├── GlassSlider.kt       ← Glass slider
    └── GlassDialog.kt       ← Glass dialog
```

---

## Step 1: Dependencies

```kotlin
dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.animation:animation")
}
```

---

## Step 2: GlassTokens.kt — core tokens

```kotlin
package com.example.app.designsystem.theme

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/** A single mesh light spot */
data class MeshSpot(
    val xFraction: Float,     // Spot center X (fraction of screen width, 0~1)
    val yFraction: Float,     // Spot center Y (fraction of screen height, 0~1)
    val color: Color,         // Spot color (with alpha)
    val radiusFraction: Float,// Spot radius (fraction of min(W,H))
)

/**
 * Glass tokens — a complete set of glass visual parameters
 */
data class GlassTokens(
    val meshBase: Color,           // Mesh base color
    val meshSpots: List<MeshSpot>, // Spot list (4-5)
    val tintConvex: Color,         // Raised surface translucent tint
    val tintConcave: Color,        // Sunken surface translucent tint
    val borderHi: Color,           // Gradient border bright end
    val borderLo: Color,           // Gradient border dark end
    val innerHighlight: Color,     // Top inner highlight line
    val outerShadow: Color,        // Outer shadow color
    val textPrimary: Color,        // Primary text color
    val textSecondary: Color,      // Secondary text color
    val textTertiary: Color,       // Tertiary text color
)

// ═══ Dark glass (vivid dark base) ═══
val DarkGlassTokens = GlassTokens(
    meshBase = Color(0xFF0F1320),
    meshSpots = listOf(
        MeshSpot(0.20f, 0.25f, Color(0x8C4A6EAA), 0.55f), // Top-left: blue-purple
        MeshSpot(0.84f, 0.16f, Color(0x73786096), 0.52f), // Top-right: gray-purple
        MeshSpot(0.30f, 0.90f, Color(0x663C7878), 0.55f), // Bottom-left: teal-green
        MeshSpot(0.90f, 0.82f, Color(0x6B5A548C), 0.55f), // Bottom-right: purple-blue
    ),
    tintConvex = Color(0x1FFFFFFF),  // 12% white → raised surfaces slightly brighter
    tintConcave = Color(0x24000000), // 14% black → sunken surfaces slightly darker
    borderHi = Color(0x8CFFFFFF),    // 55% white → bright top border
    borderLo = Color(0x1FFFFFFF),    // 12% white → dim bottom border
    innerHighlight = Color(0x73FFFFFF), // 45% white → top highlight line
    outerShadow = Color(0x47000000),    // 28% black → outer shadow
    textPrimary = Color(0xFFFFFFFF),
    textSecondary = Color(0xC7FFFFFF),
    textTertiary = Color(0x8CFFFFFF),
)

// ═══ Light glass (translucent milky white) ═══
val LightGlassTokens = GlassTokens(
    meshBase = Color(0xFFF3EFEA),  // warm light base (not pure white — has paper warmth)
    meshSpots = listOf(
        MeshSpot(0.18f, 0.22f, Color(0x735AA0F0), 0.62f), // Top-left: blue
        MeshSpot(0.86f, 0.15f, Color(0x669C8AE6), 0.60f), // Top-right: light purple
        MeshSpot(0.28f, 0.90f, Color(0x6B4FB8C9), 0.62f), // Bottom-left: cyan
        MeshSpot(0.90f, 0.84f, Color(0x617E86E0), 0.60f), // Bottom-right: blue-purple
        MeshSpot(0.52f, 0.46f, Color(0x4F7FC0E8), 0.82f), // Center: wide soft cyan-blue (removes the "blank whiteboard" feel)
    ),
    tintConvex = Color(0x2EFFFFFF),  // 18% white
    tintConcave = Color(0x12000000), // 7% black (sunken can't be too dark on light)
    borderHi = Color(0xCCFFFFFF),    // 80% white
    borderLo = Color(0x1F000000),    // 12% black
    innerHighlight = Color(0x80FFFFFF),
    outerShadow = Color(0x33737D99), // blue-gray outer shadow (matches the mesh color family)
    textPrimary = Color(0xFF1A1B1E),
    textSecondary = Color(0xB31A1B1E),
    textTertiary = Color(0x801A1B1E),
)

val LocalGlassTokens = staticCompositionLocalOf { DarkGlassTokens }
```

---

## Step 3: GlassMesh.kt — Mesh background + glass surface Modifiers

```kotlin
package com.example.app.designsystem.theme

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// ═══ Mesh drawing core ═══

/** Draw the mesh inside a DrawScope (with `origin` as the coordinate-system offset) */
private fun DrawScope.drawMesh(tokens: GlassTokens, fullSize: Size, origin: Offset) {
    drawRect(tokens.meshBase)
    val minDim = minOf(fullSize.width, fullSize.height)
    for (spot in tokens.meshSpots) {
        val center = Offset(
            x = spot.xFraction * fullSize.width - origin.x,
            y = spot.yFraction * fullSize.height - origin.y,
        )
        val radius = (spot.radiusFraction * minDim).coerceAtLeast(1f)
        // Radial gradient: spot color → transparent
        // Note: drawRect (not drawCircle) so spots cover the full screen and blend together
        drawRect(
            brush = Brush.radialGradient(
                colors = listOf(spot.color, Color.Transparent),
                center = center,
                radius = radius,
            )
        )
    }
}

// ═══ Full-screen mesh background ═══

@Composable
fun GlassMeshBackground(tokens: GlassTokens, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .drawBehind { drawMesh(tokens, fullSize = size, origin = Offset.Zero) }
    )
}

// ═══ Glass raised surface ═══

/**
 * Glass raised surface: mesh-aligned see-through + translucent light tint + gradient border + top inner highlight + outer shadow
 * Used for: cards, button default state, dialogs
 */
@Composable
fun Modifier.glassConvex(
    cornerRadius: Dp,
    tokens: GlassTokens = LocalGlassTokens.current,
): Modifier {
    var winOffset by remember { mutableStateOf(Offset.Zero) }
    val shape = RoundedCornerShape(cornerRadius)
    val configuration = LocalConfiguration.current
    val density = LocalDensity.current
    val fullSize = with(density) {
        Size(configuration.screenWidthDp.dp.toPx(), configuration.screenHeightDp.dp.toPx())
    }
    val radiusPx = with(density) { cornerRadius.toPx() }

    return this
        .onGloballyPositioned { winOffset = it.positionInWindow() }
        // Outer shadow (only a thin line below)
        .drawBehind {
            drawRoundRect(
                color = tokens.outerShadow,
                topLeft = Offset(0f, 2.dp.toPx()),
                size = size,
                cornerRadius = CornerRadius(radiusPx, radiusPx),
            )
        }
        // Clip + mesh + tint
        .clip(shape)
        .drawBehind {
            drawMesh(tokens, fullSize, winOffset)
            drawRect(tokens.tintConvex)
        }
        // Top inner highlight
        .drawWithContent {
            drawContent()
            drawRect(
                color = tokens.innerHighlight,
                size = Size(size.width, 1.dp.toPx()),
            )
        }
        // Gradient border
        .drawBehind {
            drawRoundRect(
                brush = Brush.linearGradient(listOf(tokens.borderHi, tokens.borderLo)),
                cornerRadius = CornerRadius(radiusPx, radiusPx),
                style = Stroke(width = 1.dp.toPx()),
            )
        }
}

// ═══ Glass sunken surface ═══

/**
 * Glass sunken surface: aligned mesh + dark translucent tint + gradient border
 * Used for: input fields, switch tracks, button pressed state
 */
@Composable
fun Modifier.glassConcave(
    cornerRadius: Dp,
    tokens: GlassTokens = LocalGlassTokens.current,
): Modifier {
    var winOffset by remember { mutableStateOf(Offset.Zero) }
    val shape = RoundedCornerShape(cornerRadius)
    val configuration = LocalConfiguration.current
    val density = LocalDensity.current
    val fullSize = with(density) {
        Size(configuration.screenWidthDp.dp.toPx(), configuration.screenHeightDp.dp.toPx())
    }
    val radiusPx = with(density) { cornerRadius.toPx() }

    return this
        .onGloballyPositioned { winOffset = it.positionInWindow() }
        .clip(shape)
        .drawBehind {
            drawMesh(tokens, fullSize, winOffset)
            drawRect(tokens.tintConcave)
        }
        .drawBehind {
            drawRoundRect(
                brush = Brush.linearGradient(listOf(tokens.borderHi, tokens.borderLo)),
                cornerRadius = CornerRadius(radiusPx, radiusPx),
                style = Stroke(width = 1.dp.toPx()),
            )
        }
}

// ═══ Overlay variants (for dialogs/bottom sheets — carry their own full mesh) ═══

@Composable
fun Modifier.glassConvexOverlay(cornerRadius: Dp, tokens: GlassTokens = LocalGlassTokens.current): Modifier {
    var winOffset by remember { mutableStateOf(Offset.Zero) }
    val fullSize = with(LocalDensity.current) { Size(LocalConfiguration.current.screenWidthDp.dp.toPx(), LocalConfiguration.current.screenHeightDp.dp.toPx()) }
    val radiusPx = with(LocalDensity.current) { cornerRadius.toPx() }
    return this
        .onGloballyPositioned { winOffset = it.positionInWindow() }
        .drawBehind { drawRoundRect(color = tokens.outerShadow, topLeft = Offset(0f, 2.dp.toPx()), size = size, cornerRadius = CornerRadius(radiusPx, radiusPx)) }
        .clip(RoundedCornerShape(cornerRadius))
        .drawBehind { drawMesh(tokens, fullSize, winOffset); drawRect(tokens.tintConvex) }
        .drawWithContent { drawContent(); drawRect(color = tokens.innerHighlight, size = Size(size.width, 1.dp.toPx())) }
        .drawBehind { drawRoundRect(brush = Brush.linearGradient(listOf(tokens.borderHi, tokens.borderLo)), cornerRadius = CornerRadius(radiusPx, radiusPx), style = Stroke(1.dp.toPx())) }
}

@Composable
fun Modifier.glassConcaveOverlay(cornerRadius: Dp, tokens: GlassTokens = LocalGlassTokens.current): Modifier {
    var winOffset by remember { mutableStateOf(Offset.Zero) }
    val fullSize = with(LocalDensity.current) { Size(LocalConfiguration.current.screenWidthDp.dp.toPx(), LocalConfiguration.current.screenHeightDp.dp.toPx()) }
    val radiusPx = with(LocalDensity.current) { cornerRadius.toPx() }
    return this
        .onGloballyPositioned { winOffset = it.positionInWindow() }
        .clip(RoundedCornerShape(cornerRadius))
        .drawBehind { drawMesh(tokens, fullSize, winOffset); drawRect(tokens.tintConcave) }
        .drawBehind { drawRoundRect(brush = Brush.linearGradient(listOf(tokens.borderHi, tokens.borderLo)), cornerRadius = CornerRadius(radiusPx, radiusPx), style = Stroke(1.dp.toPx())) }
}
```

> **`glassConvex/Concave` vs `glassConvexOverlay/ConcaveOverlay`**:
> - In-page components (buttons/cards/inputs) → `glassConvex/Concave`: translucent tint only, global mesh shows through
> - Standalone overlays (Dialog/BottomSheet) → `glassConvexOverlay/ConcaveOverlay`: carry their own full mesh, opaque
> - Switching: add an `isOverlay` parameter to a unified entry function (e.g. `neumorphicConvex(cornerRadius, elevation, isOverlay = true)`) that routes accordingly

---

## Step 4: GlassTypography.kt

```kotlin
package com.example.app.designsystem.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val GlassTypography = Typography(
    displayLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Bold, fontSize = 36.sp),
    headlineMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Bold, fontSize = 32.sp),
    titleLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 18.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 16.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Normal, fontSize = 14.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 14.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 12.sp),
)
```

---

## Step 5: GlassColors.kt — accent palette

```kotlin
package com.example.app.designsystem.theme

import androidx.compose.ui.graphics.Color

/** Accent colors for glass mode (coordinated with the mesh color family) */
object GlassAccent {
    val primary = Color(0xFF7C9FF5)
    val primaryDark = Color(0xFF8AADFF)
    val success = Color(0xFF5EC4A7)
    val warning = Color(0xFFFFBF6E)
    val error = Color(0xFFFF8080)
}
```

---

## Step 6: GlassButton.kt

```kotlin
package com.example.app.designsystem.component

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.app.designsystem.theme.GlassAccent
import com.example.app.designsystem.theme.LocalGlassTokens
import com.example.app.designsystem.theme.glassConcave
import com.example.app.designsystem.theme.glassConvex
import kotlinx.coroutines.delay

@Composable
fun GlassButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isLoading: Boolean = false,
    height: Dp = 52.dp,
    cornerRadius: Dp = 16.dp,
    icon: (@Composable () -> Unit)? = null,
) {
    val tokens = LocalGlassTokens.current
    val haptic = LocalHapticFeedback.current
    val interactionSource = remember { MutableInteractionSource() }
    val isPressed by interactionSource.collectIsPressedAsState()

    val scaleAnim = remember { Animatable(1f) }
    LaunchedEffect(isPressed, enabled) {
        if (isPressed && enabled) scaleAnim.snapTo(0.96f)
        else { delay(60); scaleAnim.animateTo(1f, tween(200, easing = FastOutSlowInEasing)) }
    }

    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .height(height)
            .scale(scaleAnim.value)
            .then(
                if (isPressed && enabled) glassConcave(cornerRadius, tokens)
                else glassConvex(cornerRadius, tokens)
            )
            .clip(RoundedCornerShape(cornerRadius))
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                enabled = enabled && !isLoading
            ) { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() }
            .padding(horizontal = 24.dp)
    ) {
        if (isLoading) {
            CircularProgressIndicator(
                modifier = Modifier.size(22.dp),
                color = GlassAccent.primary,
                strokeWidth = 2.dp
            )
        } else if (icon != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                icon()
                Spacer(Modifier.width(8.dp))
                Text(
                    text = text,
                    color = tokens.textPrimary,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium
                )
            }
        } else {
            Text(
                text = text,
                color = tokens.textPrimary,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium
            )
        }
    }
}
```

---

## Step 7: GlassCard.kt

```kotlin
package com.example.app.designsystem.component

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.example.app.designsystem.theme.glassConvex

@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 24.dp,
    padding: Dp = 20.dp,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = modifier
            .glassConvex(cornerRadius = cornerRadius)
            .padding(padding),
        content = { content() }
    )
}
```

---

## Step 8: GlassInput.kt

```kotlin
package com.example.app.designsystem.component

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.app.designsystem.theme.GlassAccent
import com.example.app.designsystem.theme.LocalGlassTokens
import com.example.app.designsystem.theme.glassConcave

@Composable
fun GlassInput(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    isFocused: Boolean = false,
) {
    val tokens = LocalGlassTokens.current

    Box(
        modifier = modifier
            .height(52.dp).fillMaxWidth()
            .glassConcave(cornerRadius = 14.dp, tokens)
            .then(
                if (isFocused) Modifier.drawBehind {
                    drawRoundRect(
                        brush = Brush.linearGradient(
                            listOf(GlassAccent.primary, GlassAccent.primary.copy(alpha = 0.4f))
                        ),
                        cornerRadius = CornerRadius(14.dp.toPx()),
                        style = Stroke(width = 1.5.dp.toPx())
                    )
                } else Modifier
            )
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            textStyle = LocalTextStyle.current.copy(color = tokens.textPrimary, fontSize = 15.sp),
            decorationBox = { inner ->
                if (value.isEmpty()) Text(placeholder, color = tokens.textTertiary, fontSize = 15.sp)
                inner()
            }
        )
    }
}
```

---

## Step 9: GlassSlider.kt

Sunken `glassConcave` track with a raised `glassConvex` thumb, active range filled with the accent at low transparency (0.35–0.55 per the glass rules). Drag and tap-to-seek both supported.

```kotlin
package com.example.app.designsystem.component

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.example.app.designsystem.theme.GlassAccent
import com.example.app.designsystem.theme.LocalGlassTokens
import com.example.app.designsystem.theme.glassConcave
import com.example.app.designsystem.theme.glassConvex

@Composable
fun GlassSlider(
    value: Float,
    valueRange: ClosedFloatingPointRange<Float>,
    onValueChange: (Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalGlassTokens.current
    val range = valueRange.endInclusive - valueRange.start
    val fraction = ((value - valueRange.start) / range).coerceIn(0f, 1f)
    val currentOnValueChange by rememberUpdatedState(onValueChange)

    BoxWithConstraints(
        modifier = modifier.fillMaxWidth().height(36.dp),
        contentAlignment = Alignment.CenterStart
    ) {
        val widthPx = constraints.maxWidth.toFloat()
        val thumbR = 16.dp; val thumbRPx = with(LocalDensity.current) { thumbR.toPx() }
        val maxDragPx = widthPx - thumbRPx * 2

        fun pxToValue(px: Float) {
            val f = ((px - thumbRPx) / maxDragPx).coerceIn(0f, 1f)
            currentOnValueChange(valueRange.start + f * range)
        }

        Box(
            modifier = Modifier.fillMaxSize()
                .pointerInput(Unit) { detectDragGestures { c, _ -> pxToValue(c.position.x) } }
                .pointerInput(Unit) { detectTapGestures { pxToValue(it.x) } },
            contentAlignment = Alignment.CenterStart
        ) {
            // Sunken glass track
            Box(
                modifier = Modifier.fillMaxWidth().height(10.dp)
                    .glassConcave(cornerRadius = 5.dp, tokens)
            ) {
                Box(
                    modifier = Modifier.fillMaxHeight().fillMaxWidth(fraction)
                        .background(GlassAccent.primary.copy(alpha = 0.45f), RoundedCornerShape(5.dp))
                )
            }

            // Raised glass thumb
            val thumbPx = fraction * maxDragPx
            val thumbDp = with(LocalDensity.current) { thumbPx.toDp() }
            Box(
                modifier = Modifier.offset(x = thumbDp).size(thumbR * 2)
                    .glassConvex(cornerRadius = thumbR, tokens),
                contentAlignment = Alignment.Center
            ) {
                Box(Modifier.size(8.dp).background(GlassAccent.primary, CircleShape))
            }
        }
    }
}
```

---

## Step 10: GlassDialog.kt

```kotlin
package com.example.app.designsystem.component

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.example.app.designsystem.theme.LocalGlassTokens
import com.example.app.designsystem.theme.glassConvex

@Composable
fun GlassDialog(
    title: String,
    message: String,
    confirmText: String = "Confirm",
    cancelText: String = "Cancel",
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    val tokens = LocalGlassTokens.current

    Dialog(
        onDismissRequest = onCancel,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Box(
            modifier = Modifier
                .width(300.dp).wrapContentHeight()
                .glassConvex(cornerRadius = 24.dp, tokens)
                .padding(top = 28.dp, bottom = 20.dp, start = 24.dp, end = 24.dp),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(title, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = tokens.textPrimary)
                Spacer(Modifier.height(12.dp))
                Text(
                    message, fontSize = 14.sp, lineHeight = 20.sp,
                    color = tokens.textSecondary, textAlign = TextAlign.Center
                )
                Spacer(Modifier.height(24.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    GlassButton(text = cancelText, onClick = onCancel, modifier = Modifier.weight(1f))
                    GlassButton(text = confirmText, onClick = onConfirm, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}
```

---

## Step 11: GlassTheme.kt — root theme

```kotlin
package com.example.app.designsystem.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

@Composable
fun GlassTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val tokens = if (darkTheme) DarkGlassTokens else LightGlassTokens

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = tokens.meshBase.toArgb()
            window.navigationBarColor = tokens.meshBase.toArgb()
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }

    CompositionLocalProvider(LocalGlassTokens provides tokens) {
        MaterialTheme(
            colorScheme = MaterialTheme.colorScheme.copy(
                background = tokens.meshBase,
                surface = tokens.meshBase,
                onBackground = tokens.textPrimary,
                onSurface = tokens.textPrimary,
                primary = GlassAccent.primary,
            ),
            typography = GlassTypography,
        ) {
            // Full-screen mesh background
            Box(modifier = Modifier.fillMaxSize()) {
                GlassMeshBackground(tokens)
                content()
            }
        }
    }
}
```

---

## Usage example

```kotlin
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            GlassTheme {
                val tokens = LocalGlassTokens.current
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    // Glass card
                    item {
                        GlassCard(modifier = Modifier.fillMaxWidth().height(120.dp)) {
                            Column {
                                Text("Glass Card", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = tokens.textPrimary)
                                Spacer(Modifier.height(8.dp))
                                Text("Frosted glass effect", fontSize = 14.sp, color = tokens.textSecondary)
                            }
                        }
                    }

                    // Glass button
                    item { GlassButton(text = "Primary Action", onClick = { /* ... */ }, modifier = Modifier.fillMaxWidth()) }

                    // Glass input
                    item {
                        var text by remember { mutableStateOf("") }
                        GlassInput(value = text, onValueChange = { text = it }, placeholder = "Type something...", modifier = Modifier.fillMaxWidth())
                    }

                    // Nested card layering
                    item {
                        GlassCard(modifier = Modifier.fillMaxWidth().height(80.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(Modifier.size(44.dp).glassConvex(22.dp))
                                Spacer(Modifier.width(16.dp))
                                Column {
                                    Text("Nested Layers", color = tokens.textPrimary, fontWeight = FontWeight.Medium)
                                    Text("Inner elements can also use glass surfaces", fontSize = 12.sp, color = tokens.textTertiary)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
```

---

## Design parameter quick reference

### Dark glass tokens (`DarkGlassTokens`)

| Property | Value | Description |
|------|----|------|
| meshBase | `#0F1320` | Deep blue-black base |
| tintConvex | `0x1FFFFFFF` (12%) | Slightly bright white |
| tintConcave | `0x24000000` (14%) | Slightly dark |
| borderHi | `0x8CFFFFFF` (55%) | Bright white top border |
| borderLo | `0x1FFFFFFF` (12%) | Extremely faint bottom border |
| innerHighlight | `0x73FFFFFF` (45%) | White top highlight line |
| outerShadow | `0x47000000` (28%) | Black drop shadow |
| textPrimary | `#FFFFFF` | Pure white |
| textSecondary | `0xC7FFFFFF` (78%) | Translucent white |
| textTertiary | `0x8CFFFFFF` (55%) | Transparent white |

### Light glass tokens (`LightGlassTokens`)

| Property | Value | Description |
|------|----|------|
| meshBase | `#F3EFEA` | Warm light base |
| tintConvex | `0x2EFFFFFF` (18%) | White tint overlay |
| tintConcave | `0x12000000` (7%) | Very light dark tint |
| borderHi | `0xCCFFFFFF` (80%) | Bright white border |
| borderLo | `0x1F000000` (12%) | Dark border |
| textPrimary | `0xFF1A1B1E` | Near-black |
| textSecondary | `0xB31A1B1E` (70%) | Dark gray |
| textTertiary | `0x801A1B1E` (50%) | Mid gray |

---

## Mesh spot tuning guide

Each spot has 4 parameters; here's what makes them look great:

1. **Position** (`xFraction`, `yFraction`): spread them across the four corners + center, don't cluster
2. **Color** (`color`): use mid/low-saturation colors (blue-purple, teal-green, gray-purple), alpha between `0x4F` and `0x8C`
3. **Radius** (`radiusFraction`): 0.5~0.85 — larger is softer, smaller is more concentrated
4. **Count**: 4 is enough for dark; use 5 for light (add a wide soft center spot to kill the "blank whiteboard" feel)

Tuning principle: **the colors seen through the glass should feel "subtle", not "loud"** — spot colors are a hint of ambient light, not the design's primary colors.

---

## Extended components

In glass mode, every component's `glassConvex/Concave` already handles mesh alignment + translucency + gradient border + inner highlight automatically. Component APIs are identical to the neumorphic versions — only the underlying rendering differs. See the `hyper-neumorphic` skill's "Extended component library" section for the full component list (Checkbox, RadioButton, Progress, Chip, Tabs, ListItem, Avatar, Badge, EmptyState, Skeleton, FAB, BottomSheet, etc.).

### Required control checklist

The pure glass skill must cover at least the controls below. API naming uses the `Glass*` prefix, with parameters isomorphic to the `Neumorphic*` equivalents in `hyper-neumorphic`.

| Category | Controls | Glass implementation notes |
|------|------|----------------|
| Actions | Button, IconButton, FAB, SplitButton, ToggleButton, SegmentedControl | `glassConvex` by default, `glassConcave` when pressed/selected, keep the translucent tint |
| Input | Input, PasswordInput, SearchBar, TextArea | `glassConcave` input surface, strengthen borderHi or accent inner stroke when focused |
| Numeric | Slider, RangeSlider, Stepper, RatingBar | Concave track, raised thumb/buttons, active range filled with accent at low transparency |
| Selection | Checkbox, RadioButton, Switch, Chip, DropdownMenu, DatePicker, TimePicker | Selected = concave or low-alpha accent fill, never solid color blocks |
| Navigation | TopAppBar, Tabs, NavigationBar, NavigationRail, Breadcrumb, PagerIndicator | Current item uses a glass raised/concave surface; navigation containers may be translucent but text needs enough contrast |
| Display | Card, ListItem, GridTile, StatisticCard, Timeline, Avatar, Badge, Tag, Tooltip | Let the global mesh show through; avoid large pure-white masks |
| Feedback | Dialog, BottomSheet, Snackbar, ToastHost, Progress, Spinner, Skeleton, EmptyState, ErrorState | Overlays all use the overlay variants so they hold up outside the page background |
| Containers | Section, SettingsGroup, ExpandablePanel, Carousel, PullRefreshContainer | No section-in-section; build hierarchy with spacing and transparency |

### Glass control adaptation rules

| Control | Core Modifier | Notes |
|------|-------------|--------|
| IconButton | 44dp tap target + `glassConvex(22.dp)` | icon color uses `textPrimary/textSecondary` |
| SegmentedControl | outer `glassConcave` + selected segment `glassConvex` | the selected slider must not be fully opaque |
| SearchBar | `glassConcave(18.dp)` + leading/trailing IconButton | clear button uses a small raised circle |
| PasswordInput | isomorphic with Input | trailing eye icon must not break the sunken input surface |
| TextArea | `glassConcave(18.dp)` + minLines | supports supportingText/error |
| Stepper | minus/plus `glassConvex` + center reading `glassConcave` | disabled at bounds with alpha 0.48 |
| RangeSlider | concave track + dual raised thumbs | active track color alpha 0.35-0.55 |
| RatingBar | horizontal row of IconButtons | selected can use accent, unselected textTertiary |
| TopAppBar | transparent or light `glassConvex` | add a 1dp glass border if content scrolls underneath |
| NavigationBar | bottom `glassConvexOverlay` or in-page `glassConvex` | use overlay when floating standalone |
| DropdownMenu | Popup/Dialog + `glassConvexOverlay` | must carry its own mesh, can't depend on the page backdrop |
| Snackbar | bottom `glassConvexOverlay` | action uses small GlassButton |
| DatePicker/TimePicker | Dialog + `glassConvexOverlay` | date/number cells keep 44dp tap targets |
| Skeleton | `glassConcave` + shimmer | keep shimmer alpha low to avoid flicker |
| Carousel | HorizontalPager + PagerIndicator | fixed card width/height; mesh alignment follows card movement |
| ExpandablePanel | header `glassConvex` + AnimatedVisibility | expanded area uses padding inside the same container, no nested card |

### States and accessibility

- Every interactive component provides `enabled`; disabled uses `alpha(0.48f)` and no haptics.
- Standalone overlays (Dialog, BottomSheet, Dropdown, Snackbar, Tooltip) use `glassConvexOverlay/glassConcaveOverlay`.
- Inputs, Tabs, Navigation items, Sliders must expose focused/selected/pressed states.
- Pure icon actions must have `contentDescription`; decorative icons pass `null`.
- Small visual elements still need 44dp+ tap targets.

### Short-press animation fix

All clickable components should use the `detectTapGestures` + `pointerInput` pattern instead of `MutableInteractionSource` (which lags on rapid taps). See `hyper-neumorphic` Steps 7-8 for the fixed code.

## Prohibitions and cautions

- **GlassTheme must wrap the outermost layer**
- **Don't combine neumorphism + glassmorphism**
- **`positionInWindow()` is critical**: skipping it degrades surfaces to flat translucent panels
- **Glass surfaces must use `clip()`**: otherwise the mesh draws outside the rounded corners
- **tintConvex must not exceed 0.25**: too high obscures the mesh spots
- **Light-mode tintConcave should be lower**: 7% is enough
- **First frame uses `LocalConfiguration.screenWidthDp/screenHeightDp`**: never rely on `view.width/height`
