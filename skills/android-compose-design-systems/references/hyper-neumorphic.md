---
name: hyper-neumorphic
description: HyperOS/Pengpai style dual-engine design system (neumorphism + glassmorphism) — a complete Android Jetpack Compose UI kit. Includes dual-tone embossed shadows (BlurMaskFilter raised/sunken), glass Mesh light spots + translucent overlays, one-tap engine switching (LocalAppSkin), light/dark auto-adaptation, detectTapGestures short/long-press animations, haptic feedback, a 28dp corner-radius system, and 40+ common control specs including Button/Input/SearchBar/NavigationBar/Dialog/BottomSheet/DatePicker.
---

# Hyper-Neumorphic Design System

A complete Android Jetpack Compose design system fusing the HyperOS/Pengpai OS design language with neumorphic embossed aesthetics.

## Design characteristics

- **Dual-tone embossed shadows**: `BlurMaskFilter`-driven bright highlight (top-left) + dark shadow (bottom-right) simulating 3D raised/sunken states
- **Light/dark auto-adaptation**: `HyperColors` palette (27 colors each for Light/Dark), including page gradients, card gradients, and semantic colors
- **Ripple-free clicks**: press scale 0.95 → spring back to 1.0 on release, 150ms FastOutSlowInEasing, no water ripple
- **Light/shadow linkage**: buttons switch convex → concave on press, concave → convex on release
- **Haptic feedback**: every interactive button carries `HapticFeedbackType.TextHandleMove`
- **28dp corner-radius system**: card 28dp → dialog 24dp → button 26dp → input 16dp → chip 14dp
- **6 theme colors**: default blue / deep sea blue / sakura pink / mint green / lavender purple + dynamic color (Android 12+)

## When to use

This skill is designed for **new Android Jetpack Compose projects**. Use it when the user asks for:
- "Build a HyperOS-style UI"
- "Make a neumorphic design system"
- "Generate a UI style like MR-Linker"
- "Build a Xiaomi Pengpai-style Compose component library"

## File structure

Create the following files in the project (package `com.example.app.designsystem`, adjust as needed):

```
ui/designsystem/
├── theme/
│   ├── Color.kt          ← HyperColors palette + neumorphic shadow colors
│   ├── Type.kt           ← Material 3 Typography
│   ├── Spacing.kt        ← spacing/corner radius/icon size constants
│   ├── NeumorphicModifiers.kt  ← convex/concave shadow Modifiers
│   └── Theme.kt          ← AppTheme root Composable (light/dark switching)
├── token/
│   ├── HyperosClick.kt   ← HyperOS ripple-free click Modifier
│   └── NeumorphicInteraction.kt  ← neumorphic light/shadow linkage click
└── component/
    ├── NeumorphicButton.kt   ← primary button
    ├── NeumorphicSwitch.kt   ← switch
    ├── NeumorphicSlider.kt   ← slider
    ├── NeumorphicInputField.kt ← input field
    └── HyperOSDialog.kt      ← dialog
```

---

## Step 1: Dependencies

Confirm `app/build.gradle.kts` already has the Compose BOM + Material 3:

```kotlin
dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.core:core-ktx:1.13.1")
}
```

---

## Step 2: Color.kt

```kotlin
package com.example.app.designsystem.theme

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

// ═══ HyperColors palette ═══
data class HyperColors(
    val background: Color,
    val cardBackground: Color,
    val pageGradientTop: Color,
    val pageGradientMid: Color,
    val pageGradientBottom: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textTertiary: Color,
    val primary: Color,
    val primaryVariant: Color,
    val success: Color,
    val warning: Color,
    val error: Color,
    val rangeStart: Color,
    val rangeEnd: Color,
    val rangeAccent: Color,
    val tempStart: Color,
    val tempEnd: Color,
    val tempAccent: Color,
    val tripGradStart: Color,
    val tripGradEnd: Color,
    val healthGradStart: Color,
    val healthGradEnd: Color,
    val iconBackground: Color,
    val badgeBackground: Color,
    val badgeText: Color,
    val border: Color,
    val divider: Color,
    val liquidScreenBg: Color,
    val liquidCardBg: Color,
    val liquidEditOverlayBg: Color,
    val liquidDangerBg: Color,
)

val LightHyperColors = HyperColors(
    background = Color(0xFFF2F4F8),
    cardBackground = Color(0xFFFFFFFF),
    pageGradientTop = Color(0xFFEAF1FF),
    pageGradientMid = Color(0xFFF5F6FB),
    pageGradientBottom = Color(0xFFFFFFFF),
    textPrimary = Color(0xFF111111),
    textSecondary = Color(0xFF6F7280),
    textTertiary = Color(0xFFB5B5C0),
    primary = Color(0xFF007AFF),
    primaryVariant = Color(0xFF0062CC),
    success = Color(0xFF32BB78),
    warning = Color(0xFFFFB300),
    error = Color(0xFFFF5252),
    rangeStart = Color(0xFFD7F2DE),
    rangeEnd = Color(0xFFE8FFE8),
    rangeAccent = Color(0xFF32BB78),
    tempStart = Color(0xFFD9F0FF),
    tempEnd = Color(0xFFEAF7FF),
    tempAccent = Color(0xFF1976D2),
    tripGradStart = Color(0xFFE2EBFF),
    tripGradEnd = Color(0xFFF1F5FF),
    healthGradStart = Color(0xFFD7F2DE),
    healthGradEnd = Color(0xFFEEFBF1),
    iconBackground = Color(0xFFF2F4F8),
    badgeBackground = Color(0xFFE8F4FF),
    badgeText = Color(0xFF007AFF),
    border = Color(0xFFE5E5E5),
    divider = Color(0xFFF0F0F0),
    liquidScreenBg = Color(0xFFF2F4F8),
    liquidCardBg = Color(0xFFFFFFFF),
    liquidEditOverlayBg = Color(0xCC1F2937),
    liquidDangerBg = Color(0xFFFF4D4F),
)

val DarkHyperColors = HyperColors(
    background = Color(0xFF1A1B1E),
    cardBackground = Color(0xFF1E1E1E),
    pageGradientTop = Color(0xFF0D1117),
    pageGradientMid = Color(0xFF12161C),
    pageGradientBottom = Color(0xFF1A1E25),
    textPrimary = Color(0xFFF5F5F5),
    textSecondary = Color(0xFFB3B3B3),
    textTertiary = Color(0xFF808080),
    primary = Color(0xFF0A84FF),
    primaryVariant = Color(0xFF0070E0),
    success = Color(0xFF30D158),
    warning = Color(0xFFFFB74D),
    error = Color(0xFFFF8A80),
    rangeStart = Color(0xFF1B3A24),
    rangeEnd = Color(0xFF223D2A),
    rangeAccent = Color(0xFF30D158),
    tempStart = Color(0xFF1A2E3D),
    tempEnd = Color(0xFF1E3344),
    tempAccent = Color(0xFF82B1FF),
    tripGradStart = Color(0xFF1A2340),
    tripGradEnd = Color(0xFF1E2845),
    healthGradStart = Color(0xFF1B3A24),
    healthGradEnd = Color(0xFF1F3D28),
    iconBackground = Color(0xFF2A2A2A),
    badgeBackground = Color(0xFF0A2A4A),
    badgeText = Color(0xFF0A84FF),
    border = Color(0xFF2D2D2D),
    divider = Color(0xFF262626),
    liquidScreenBg = Color(0xFF1A1B1E),
    liquidCardBg = Color(0xFF1A1D22),
    liquidEditOverlayBg = Color(0xCC0F1115),
    liquidDangerBg = Color(0xFFFF6B6E),
)

val LocalHyperColors = staticCompositionLocalOf { LightHyperColors }

// Neumorphic shadow colors
val NeumLightHighlight = Color(0xFFFFFFFF)
val NeumLightShadow = Color(0xFFD1D9E6)
val NeumDarkLight = Color(0xFF26282C)
val NeumDarkDark = Color(0xFF0D0E11)

// Xiaomi brand colors
val MiBlue40 = Color(0xFF4C8EFF)
val MiGreen40 = Color(0xFF6DD400)
val MiBlue80 = Color(0xFFADC9FF)
val MiGreen80 = Color(0xFFB5F37F)
```

---

## Step 3: Type.kt

```kotlin
package com.example.app.designsystem.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val AppTypography = Typography(
    displayLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Bold,
        fontSize = 36.sp,
        letterSpacing = 0.sp
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Bold,
        fontSize = 32.sp,
        letterSpacing = 0.sp
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 18.sp,
        letterSpacing = 0.sp
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 16.sp,
        letterSpacing = 0.sp
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.sp
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        letterSpacing = 0.sp
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        letterSpacing = 0.sp
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        letterSpacing = 0.sp
    ),
)
```

---

## Step 4: Spacing.kt

```kotlin
package com.example.app.designsystem.theme

import androidx.compose.ui.unit.dp

object AppSpacing {
    val safeHorizontal = 24.dp
    val cardGap = 12.dp
    val cardCornerRadius = 28.dp
    val pillCornerRadius = 999.dp
    val cardInnerPadding = 16.dp
    val cardInnerGap = 12.dp
    val controlButtonHeight = 48.dp
    val chipHeight = 32.dp
    val iconSizeSm = 16.dp
    val iconSizeMd = 20.dp
    val iconSizeLg = 24.dp
    val fabSize = 48.dp
}
```

---

## Step 5: NeumorphicModifiers.kt — the core embossed shadow engine

```kotlin
package com.example.app.designsystem.theme

import android.graphics.BlurMaskFilter
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Get the correct embossed shadow colors for the current light/dark mode */
@Composable
fun getNeumorphicColors(): Triple<Color, Color, Color> {
    val colors = LocalHyperColors.current
    val isDark = colors === DarkHyperColors
    val bgColor = colors.liquidScreenBg
    val lightShadow = if (isDark) Color(0xFF26282C) else Color(0xFFFFFFFF)
    val darkShadow = if (isDark) Color(0xFF0D0E11) else Color(0xFFD1D9E6)
    return Triple(bgColor, lightShadow, darkShadow)
}

/**
 * Raised surface: embossed shadow for neumorphism, translucent overlay for glass mode.
 * isOverlay=true (dialogs/bottom sheets and other standalone overlays) → glass mode uses glassConvexOverlay (carries its own mesh)
 */
@Composable
fun Modifier.neumorphicConvex(
    cornerRadius: Dp = 24.dp,
    elevation: Dp = 6.dp,
    isOverlay: Boolean = false,
): Modifier {
    if (LocalAppSkin.current == AppSkin.GLASS) {
        return if (isOverlay) this.glassConvexOverlay(cornerRadius, LocalGlassTokens.current)
        else this.glassConvex(cornerRadius, LocalGlassTokens.current)
    }
    val (bgColor, lightShadow, darkShadow) = getNeumorphicColors()

    return this
        .clip(RoundedCornerShape(cornerRadius))
        .background(bgColor)
        .drawBehind {
            drawIntoCanvas { canvas ->
                val composePaint = Paint().apply {
                    asFrameworkPaint().apply {
                        isAntiAlias = true
                        maskFilter = BlurMaskFilter(elevation.toPx(), BlurMaskFilter.Blur.NORMAL)
                    }
                }
                // Bottom-right dark shadow
                composePaint.color = darkShadow
                canvas.drawRoundRect(
                    left = elevation.toPx() * 0.5f,
                    top = elevation.toPx() * 0.5f,
                    right = size.width + elevation.toPx() * 0.5f,
                    bottom = size.height + elevation.toPx() * 0.5f,
                    radiusX = cornerRadius.toPx(),
                    radiusY = cornerRadius.toPx(),
                    paint = composePaint
                )
                // Top-left highlight
                composePaint.color = lightShadow
                canvas.drawRoundRect(
                    left = -elevation.toPx() * 0.5f,
                    top = -elevation.toPx() * 0.5f,
                    right = size.width - elevation.toPx() * 0.5f,
                    bottom = size.height - elevation.toPx() * 0.5f,
                    radiusX = cornerRadius.toPx(),
                    radiusY = cornerRadius.toPx(),
                    paint = composePaint
                )
            }
        }
}

/**
 * Sunken neumorphic surface: inner shadow for the pressed-in feel, isOverlay as above.
 */
@Composable
fun Modifier.neumorphicConcave(
    cornerRadius: Dp = 24.dp,
    elevation: Dp = 4.dp,
    isOverlay: Boolean = false,
): Modifier {
    if (LocalAppSkin.current == AppSkin.GLASS) {
        return if (isOverlay) this.glassConcaveOverlay(cornerRadius, LocalGlassTokens.current)
        else this.glassConcave(cornerRadius, LocalGlassTokens.current)
    }
    val (bgColor, lightShadow, darkShadow) = getNeumorphicColors()

    return this
        .clip(RoundedCornerShape(cornerRadius))
        .background(bgColor)
        .drawWithContent {
            drawIntoCanvas { canvas ->
                val radiusPx = cornerRadius.toPx()
                val elevationPx = elevation.toPx()
                val blurFilter = BlurMaskFilter(elevationPx, BlurMaskFilter.Blur.NORMAL)

                // Top-left dark inner shadow
                val darkPaint = Paint().apply {
                    color = darkShadow.copy(alpha = 0.8f)
                    asFrameworkPaint().apply {
                        isAntiAlias = true
                        maskFilter = blurFilter
                        style = android.graphics.Paint.Style.STROKE
                        strokeWidth = elevationPx * 2
                    }
                }
                canvas.drawRoundRect(
                    left = -elevationPx * 0.5f,
                    top = -elevationPx * 0.5f,
                    right = size.width,
                    bottom = size.height,
                    radiusX = radiusPx,
                    radiusY = radiusPx,
                    paint = darkPaint
                )

                // Bottom-right bright inner highlight
                val lightPaint = Paint().apply {
                    color = lightShadow
                    asFrameworkPaint().apply {
                        isAntiAlias = true
                        maskFilter = blurFilter
                        style = android.graphics.Paint.Style.STROKE
                        strokeWidth = elevationPx * 2
                    }
                }
                canvas.drawRoundRect(
                    left = 0f,
                    top = 0f,
                    right = size.width + elevationPx * 0.5f,
                    bottom = size.height + elevationPx * 0.5f,
                    radiusX = radiusPx,
                    radiusY = radiusPx,
                    paint = lightPaint
                )
            }
            drawContent()
        }
}

/** Convenience method merging convex + background (alias of neumorphicConvex) */
@Composable
fun Modifier.neumorphic3D(cornerRadius: Dp = 28.dp, elevation: Dp = 8.dp, isOverlay: Boolean = false): Modifier =
    this.neumorphicConvex(cornerRadius, elevation, isOverlay)
```

---

## Step 6: HyperosClick.kt — ripple-free click animation

```kotlin
package com.example.app.designsystem.token

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput

/**
 * HyperOS-style click modifier
 * Press scale=0.95 → spring back to 1.0 on release, no water ripple, 150ms FastOutSlowInEasing
 */
fun Modifier.hyperosClickable(
    enabled: Boolean = true,
    onClick: () -> Unit = {}
): Modifier = composed {
    var isPressed by remember { mutableStateOf(false) }

    val scale by animateFloatAsState(
        targetValue = if (isPressed && enabled) 0.95f else 1f,
        animationSpec = tween(150, easing = FastOutSlowInEasing),
        label = "hyperos_scale"
    )

    this
        .graphicsLayer { scaleX = scale; scaleY = scale }
        .pointerInput(enabled) {
            if (enabled) {
                detectTapGestures(
                    onPress = { isPressed = true; tryAwaitRelease(); isPressed = false },
                    onTap = { onClick() }
                )
            }
        }
}
```

---

## Step 7: NeumorphicInteraction.kt — light/shadow linkage click

```kotlin
package com.example.app.designsystem.token

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.example.app.designsystem.theme.neumorphicConcave
import com.example.app.designsystem.theme.neumorphicConvex
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Unified neumorphic click: scale + haptics + no ripple + light/shadow linkage (concave on press, convex on release)
 * Uses detectTapGestures instead of MutableInteractionSource so both short taps and long presses animate.
 */
@Composable
fun Modifier.neumorphicClickable(
    enabled: Boolean = true,
    cornerRadius: Dp = 24.dp,
    convexElevation: Dp = 6.dp,
    concaveElevation: Dp = 4.dp,
    scalePressed: Float = 0.95f,
    durationMs: Int = 150,
    hapticType: HapticFeedbackType = HapticFeedbackType.TextHandleMove,
    onClick: () -> Unit
): Modifier {
    val haptic = LocalHapticFeedback.current
    var isPressed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val scaleAnim = remember { Animatable(1f) }

    return this
        .scale(scaleAnim.value)
        .then(
            if (isPressed && enabled) Modifier.neumorphicConcave(cornerRadius, concaveElevation)
            else Modifier.neumorphicConvex(cornerRadius, convexElevation)
        )
        .pointerInput(enabled) {
            if (enabled) detectTapGestures(
                onPress = {
                    isPressed = true
                    scope.launch { scaleAnim.snapTo(scalePressed) }
                    tryAwaitRelease()
                    isPressed = false
                    scope.launch { delay(60); scaleAnim.animateTo(1f, tween(durationMs, easing = FastOutSlowInEasing)) }
                },
                onTap = { haptic.performHapticFeedback(hapticType); onClick() }
            )
        }
}

/**
 * Simplified variant: scale + haptics only, no shadow state change (for elements with their own styling, e.g. selected chips)
 */
@Composable
fun Modifier.neumorphicTap(
    enabled: Boolean = true,
    scalePressed: Float = 0.95f,
    durationMs: Int = 150,
    hapticType: HapticFeedbackType = HapticFeedbackType.TextHandleMove,
    onClick: () -> Unit
): Modifier {
    val haptic = LocalHapticFeedback.current
    var isPressed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val scaleAnim = remember { Animatable(1f) }

    return this
        .scale(scaleAnim.value)
        .pointerInput(enabled) {
            if (enabled) detectTapGestures(
                onPress = {
                    isPressed = true
                    scope.launch { scaleAnim.snapTo(scalePressed) }
                    tryAwaitRelease()
                    isPressed = false
                    scope.launch { delay(60); scaleAnim.animateTo(1f, tween(durationMs, easing = FastOutSlowInEasing)) }
                },
                onTap = { haptic.performHapticFeedback(hapticType); onClick() }
            )
        }
}
```

---

## Step 8: NeumorphicButton.kt

```kotlin
package com.example.app.designsystem.component

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.app.designsystem.theme.DarkHyperColors
import com.example.app.designsystem.theme.LocalHyperColors
import com.example.app.designsystem.theme.neumorphicConcave
import com.example.app.designsystem.theme.neumorphicConvex
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Generic neumorphic button
 * - Default: raised (convex)
 * - Pressed: sunken (concave) + scale 0.95
 * - Disabled: flat sunken (elevation=1.5dp), text at 30% alpha
 * - Loading: text replaced with CircularProgressIndicator
 * - Uses detectTapGestures so short presses animate instantly
 */
@Composable
fun NeumorphicButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isPrimary: Boolean = true,
    isLoading: Boolean = false,
    height: Dp = 52.dp,
    cornerRadius: Dp = 26.dp,
    icon: (@Composable () -> Unit)? = null,
) {
    val haptic = LocalHapticFeedback.current
    val colors = LocalHyperColors.current
    val isDark = colors === DarkHyperColors

    // pointerInput + detectTapGestures so short presses animate too
    var isPressed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val scaleAnim = remember { Animatable(1f) }

    fun pressDown() { isPressed = true; scope.launch { scaleAnim.snapTo(0.95f) } }
    fun pressUp() { isPressed = false; scope.launch { delay(60); scaleAnim.animateTo(1f, tween(200, easing = FastOutSlowInEasing)) } }

    val textColor = when {
        !enabled -> (if (isDark) Color.White else Color.Black).copy(alpha = 0.3f)
        isPrimary -> colors.primary
        else -> colors.textSecondary
    }
    val tintColor = textColor.copy(alpha = 0.03f)

    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .height(height)
            .scale(scaleAnim.value)
            .then(
                when {
                    !enabled -> Modifier.neumorphicConcave(cornerRadius, elevation = 1.5.dp)
                    isPressed -> Modifier.neumorphicConcave(cornerRadius)
                    else -> Modifier.neumorphicConvex(cornerRadius)
                }
            )
            .clip(RoundedCornerShape(cornerRadius))
            .background(tintColor)
            .pointerInput(enabled) {
                if (enabled && !isLoading) detectTapGestures(
                    onPress = { pressDown(); tryAwaitRelease(); pressUp() },
                    onTap = { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() }
                )
            }
            .padding(horizontal = 24.dp)
    ) {
        if (isLoading) {
            CircularProgressIndicator(
                modifier = Modifier.size(22.dp),
                color = colors.primary,
                strokeWidth = 2.dp
            )
        } else if (icon != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                icon()
                Spacer(Modifier.width(6.dp))
                Text(
                    text = text,
                    color = textColor,
                    fontSize = 16.sp,
                    fontWeight = if (isPrimary) FontWeight.SemiBold else FontWeight.Normal
                )
            }
        } else {
            Text(
                text = text,
                color = textColor,
                fontSize = 16.sp,
                fontWeight = if (isPrimary) FontWeight.SemiBold else FontWeight.Normal
            )
        }
    }
}
```

---

## Step 9: NeumorphicSwitch.kt

```kotlin
package com.example.app.designsystem.component

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.dp
import com.example.app.designsystem.theme.DarkHyperColors
import com.example.app.designsystem.theme.LocalHyperColors
import com.example.app.designsystem.theme.neumorphicConcave
import com.example.app.designsystem.theme.neumorphicConvex

/**
 * Neumorphic switch
 * Track: sunken trough (52×28dp, 14dp radius)
 * Thumb: raised sphere (20dp), offset 4dp↔24dp with 250ms animation
 * Active color: dark mode = primary, light mode = success
 */
@Composable
fun NeumorphicSwitch(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val haptic = LocalHapticFeedback.current
    val colors = LocalHyperColors.current
    val isDark = colors === DarkHyperColors

    val thumbOffset by animateDpAsState(
        targetValue = if (checked) 24.dp else 4.dp,
        animationSpec = tween(250, easing = FastOutSlowInEasing),
        label = "switch_thumb"
    )

    val trackColor by animateColorAsState(
        targetValue = if (checked) {
            if (isDark) colors.primary else colors.success
        } else {
            Color.Transparent
        },
        animationSpec = tween(250),
        label = "switch_track"
    )

    Box(
        modifier = modifier
            .width(52.dp)
            .height(28.dp)
            .neumorphicConcave(cornerRadius = 14.dp, elevation = 1.5.dp)
            .background(trackColor, RoundedCornerShape(14.dp))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    onCheckedChange(!checked)
                }
            )
    ) {
        Box(
            modifier = Modifier
                .offset(x = thumbOffset)
                .align(Alignment.CenterStart)
                .size(20.dp)
                .neumorphicConvex(cornerRadius = 10.dp, elevation = 1.5.dp)
        )
    }
}
```

---

## Step 10: NeumorphicSlider.kt

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
import com.example.app.designsystem.theme.LocalHyperColors
import com.example.app.designsystem.theme.neumorphicConcave
import com.example.app.designsystem.theme.neumorphicConvex

/**
 * Neumorphic slider
 * Track: sunken trough (14dp high), active segment tinted, optional tick mark
 * Thumb: 32dp raised sphere + 8dp inner color dot
 */
@Composable
fun NeumorphicSlider(
    value: Float,
    valueRange: ClosedFloatingPointRange<Float>,
    onValueChange: (Float) -> Unit,
    activeColor: Color,
    limitValue: Float? = null,
    modifier: Modifier = Modifier,
) {
    val range = valueRange.endInclusive - valueRange.start
    val fraction = ((value - valueRange.start) / range).coerceIn(0f, 1f)
    val currentOnValueChange by rememberUpdatedState(onValueChange)

    BoxWithConstraints(
        modifier = modifier.fillMaxWidth().height(32.dp),
        contentAlignment = Alignment.CenterStart
    ) {
        val widthPx = constraints.maxWidth.toFloat()
        val thumbRadiusDp = 16.dp
        val thumbRadiusPx = with(LocalDensity.current) { thumbRadiusDp.toPx() }
        val maxDragPx = widthPx - thumbRadiusPx * 2

        fun updateValueFromPx(px: Float) {
            val newFraction = ((px - thumbRadiusPx) / maxDragPx).coerceIn(0f, 1f)
            currentOnValueChange(valueRange.start + newFraction * range)
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(constraints.maxWidth) {
                    detectDragGestures { change, _ -> updateValueFromPx(change.position.x) }
                }
                .pointerInput(constraints.maxWidth) {
                    detectTapGestures { offset -> updateValueFromPx(offset.x) }
                },
            contentAlignment = Alignment.CenterStart
        ) {
            // Track
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(14.dp)
                    .neumorphicConcave(cornerRadius = 7.dp, elevation = 2.dp)
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxHeight()
                        .fillMaxWidth(fraction = fraction)
                        .background(activeColor.copy(alpha = 0.8f), RoundedCornerShape(7.dp))
                )
            }

            // Tick mark
            if (limitValue != null) {
                val limitFraction = ((limitValue - valueRange.start) / range).coerceIn(0f, 1f)
                val limitPx = limitFraction * maxDragPx + thumbRadiusPx
                val limitDp = with(LocalDensity.current) { limitPx.toDp() }
                Box(
                    modifier = Modifier
                        .offset(x = limitDp - 1.5.dp)
                        .width(3.dp).height(24.dp)
                        .background(
                            LocalHyperColors.current.textPrimary.copy(alpha = 0.3f),
                            RoundedCornerShape(1.5.dp)
                        )
                )
            }

            // Thumb
            val thumbOffsetPx = fraction * maxDragPx
            val thumbOffsetDp = with(LocalDensity.current) { thumbOffsetPx.toDp() }
            Box(
                modifier = Modifier
                    .offset(x = thumbOffsetDp)
                    .size(thumbRadiusDp * 2)
                    .neumorphicConvex(cornerRadius = thumbRadiusDp, elevation = 2.dp),
                contentAlignment = Alignment.Center
            ) {
                Box(modifier = Modifier.size(8.dp).background(activeColor, CircleShape))
            }
        }
    }
}
```

---

## Step 11: NeumorphicInputField.kt

```kotlin
package com.example.app.designsystem.component

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.app.designsystem.theme.LocalHyperColors
import com.example.app.designsystem.theme.neumorphicConcave

/**
 * Neumorphic input field
 * Sunken trough (56dp high, 16dp radius), primary-colored border when focused
 */
@Composable
fun NeumorphicInputField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    leadingIcon: @Composable (() -> Unit)? = null,
    trailingContent: @Composable (() -> Unit)? = null,
    isFocused: Boolean = false,
) {
    val colors = LocalHyperColors.current

    Box(
        modifier = modifier
            .height(56.dp)
            .fillMaxWidth()
            .neumorphicConcave(cornerRadius = 16.dp, elevation = 2.dp)
            .then(
                if (isFocused) Modifier.border(1.dp, colors.primary, RoundedCornerShape(16.dp))
                else Modifier
            )
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            if (leadingIcon != null) leadingIcon()
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier.weight(1f),
                textStyle = LocalTextStyle.current.copy(
                    color = colors.textPrimary,
                    fontSize = 16.sp
                ),
                decorationBox = { inner ->
                    if (value.isEmpty()) {
                        Text(
                            text = placeholder,
                            color = colors.textSecondary,
                            fontSize = 16.sp
                        )
                    }
                    inner()
                }
            )
            if (trailingContent != null) trailingContent()
        }
    }
}
```

---

## Step 12: HyperOSDialog.kt

```kotlin
package com.example.app.designsystem.component

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
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
import com.example.app.designsystem.theme.neumorphic3D

/**
 * HyperOS-style dialog
 * 320dp wide, 24dp radius, 8dp highest embossed elevation
 */
@Composable
fun HyperOSDialog(
    title: String,
    message: String,
    confirmText: String,
    cancelText: String,
    onConfirm: () -> Unit,
    onCancel: () -> Unit
) {
    Dialog(
        onDismissRequest = onCancel,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Box(
            modifier = Modifier
                .width(320.dp)
                .wrapContentHeight()
                .neumorphic3D(cornerRadius = 24.dp, elevation = 8.dp, isOverlay = true)  // dialogs use isOverlay; glass mode carries its own mesh
        ) {
            Column(
                modifier = Modifier.padding(top = 32.dp, bottom = 24.dp, start = 24.dp, end = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = title,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    text = message,
                    fontSize = 15.sp,
                    lineHeight = 22.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center
                )
                Spacer(modifier = Modifier.height(32.dp))
                Row(
                    modifier = Modifier.width(272.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    NeumorphicButton(
                        text = cancelText,
                        onClick = onCancel,
                        isPrimary = false,
                        modifier = Modifier.weight(1f)
                    )
                    NeumorphicButton(
                        text = confirmText,
                        onClick = onConfirm,
                        isPrimary = true,
                        modifier = Modifier.weight(1f)
                    )
                }
            }
        }
    }
}
```

---

## Step 13: Theme.kt — root theme

```kotlin
package com.example.app.designsystem.theme

import android.app.Activity
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

@Composable
fun AppTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        if (darkTheme) dynamicDarkColorScheme(LocalContext.current)
        else dynamicLightColorScheme(LocalContext.current)
    } else {
        if (darkTheme) darkColorScheme(primary = MiBlue80, secondary = MiGreen80)
        else lightColorScheme(primary = MiBlue40, secondary = MiGreen40)
    }

    val hyperColors = if (darkTheme) DarkHyperColors else LightHyperColors

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = Color.Transparent.toArgb()
            window.navigationBarColor = Color.Transparent.toArgb()
            val insetsController = WindowCompat.getInsetsController(window, view)
            insetsController.isAppearanceLightStatusBars = !darkTheme
            insetsController.isAppearanceLightNavigationBars = !darkTheme
        }
    }

    CompositionLocalProvider(LocalHyperColors provides hyperColors) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = AppTypography,
            content = content
        )
    }
}
```

---

## Usage example

```kotlin
// MainActivity.kt
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            AppTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = LocalHyperColors.current.background
                ) {
                    Column(
                        modifier = Modifier.padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp)
                    ) {
                        // Raised card
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(120.dp)
                                .neumorphicConvex(cornerRadius = 28.dp, elevation = 6.dp)
                                .padding(16.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text("Neumorphic Card", style = MaterialTheme.typography.titleLarge)
                        }

                        // Primary button
                        NeumorphicButton(text = "Confirm", onClick = { /* ... */ })

                        // Switch
                        var checked by remember { mutableStateOf(false) }
                        NeumorphicSwitch(checked = checked, onCheckedChange = { checked = it })

                        // Input field
                        var text by remember { mutableStateOf("") }
                        NeumorphicInputField(value = text, onValueChange = { text = it }, placeholder = "Type something")
                    }
                }
            }
        }
    }
}
```

---

## Customization options

### Corner-radius hierarchy

| Element | Radius | elevation |
|------|------|-----------|
| Page card | 28dp | 6dp |
| Dialog | 24dp | 8dp |
| Button | 26dp | 6dp (default) / 4dp (pressed) |
| Input field | 16dp | 2dp |
| Switch track | 14dp | 1.5dp |
| Chip | 14dp | 3dp |
| Icon button | 18dp | 3dp |

### Animation parameters

| Animation | Duration | Curve |
|------|------|------|
| Button press/release | 150ms/200ms | FastOutSlowInEasing |
| Switch slide | 250ms | FastOutSlowInEasing |
| Staggered entrance (per element) | 1000ms | FastOutSlowInEasing |

### Staggered entrance animation (optional)

```kotlin
fun Modifier.staggeredEntrance(visible: Boolean, delayMillis: Int): Modifier = composed {
    val alpha by animateFloatAsState(
        targetValue = if (visible) 1f else 0f,
        animationSpec = tween(1000, delayMillis, FastOutSlowInEasing),
        label = "entrance_alpha"
    )
    val offsetY by animateFloatAsState(
        targetValue = if (visible) 0f else 60f,
        animationSpec = tween(1000, delayMillis, FastOutSlowInEasing),
        label = "entrance_offset"
    )
    val scale by animateFloatAsState(
        targetValue = if (visible) 1f else 0.92f,
        animationSpec = tween(1000, delayMillis, FastOutSlowInEasing),
        label = "entrance_scale"
    )
    this
        .graphicsLayer { this.alpha = alpha; translationY = offsetY; scaleX = scale; scaleY = scale }
}
// Usage: pass progressively increasing delayMillis (0, 150, 250, 350, 450...) to each child in a Column
```

---

## Step 14: GlassTokens.kt — glass tokens

```kotlin
package com.example.app.designsystem.theme

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

data class MeshSpot(val xFraction: Float, val yFraction: Float, val color: Color, val radiusFraction: Float)

data class GlassTokens(
    val meshBase: Color, val meshSpots: List<MeshSpot>,
    val tintConvex: Color, val tintConcave: Color,
    val borderHi: Color, val borderLo: Color,
    val innerHighlight: Color, val outerShadow: Color,
    val textPrimary: Color, val textSecondary: Color, val textTertiary: Color,
)

val DarkGlassTokens = GlassTokens(
    meshBase = Color(0xFF0F1320),
    meshSpots = listOf(
        MeshSpot(0.20f, 0.25f, Color(0x8C4A6EAA), 0.55f), MeshSpot(0.84f, 0.16f, Color(0x73786096), 0.52f),
        MeshSpot(0.30f, 0.90f, Color(0x663C7878), 0.55f), MeshSpot(0.90f, 0.82f, Color(0x6B5A548C), 0.55f),
    ),
    tintConvex = Color(0x1FFFFFFF), tintConcave = Color(0x24000000),
    borderHi = Color(0x8CFFFFFF), borderLo = Color(0x1FFFFFFF),
    innerHighlight = Color(0x73FFFFFF), outerShadow = Color(0x47000000),
    textPrimary = Color(0xFFFFFFFF), textSecondary = Color(0xC7FFFFFF), textTertiary = Color(0x8CFFFFFF),
)

val LightGlassTokens = GlassTokens(
    meshBase = Color(0xFFF3EFEA),
    meshSpots = listOf(
        MeshSpot(0.18f, 0.22f, Color(0x735AA0F0), 0.62f), MeshSpot(0.86f, 0.15f, Color(0x669C8AE6), 0.60f),
        MeshSpot(0.28f, 0.90f, Color(0x6B4FB8C9), 0.62f), MeshSpot(0.90f, 0.84f, Color(0x617E86E0), 0.60f),
        MeshSpot(0.52f, 0.46f, Color(0x4F7FC0E8), 0.82f),
    ),
    tintConvex = Color(0x2EFFFFFF), tintConcave = Color(0x12000000),
    borderHi = Color(0xCCFFFFFF), borderLo = Color(0x1F000000),
    innerHighlight = Color(0x80FFFFFF), outerShadow = Color(0x33737D99),
    textPrimary = Color(0xFF1A1B1E), textSecondary = Color(0xB31A1B1E), textTertiary = Color(0x801A1B1E),
)

val LocalGlassTokens = staticCompositionLocalOf { DarkGlassTokens }
enum class AppSkin { NEUMORPHISM, GLASS }
val LocalAppSkin = staticCompositionLocalOf { AppSkin.NEUMORPHISM }
fun glassTokensFor(isDark: Boolean) = if (isDark) DarkGlassTokens else LightGlassTokens
```

## Step 15: GlassSurface.kt — global mesh background + translucent glass overlays

> **Key design decision**: only `GlassMeshBackground` draws the mesh spots globally. `glassConvex/Concave` do NOT redraw the mesh — they only apply translucent tints — so the global mesh underneath shows through naturally, producing a unified glass texture.

```kotlin
package com.example.app.designsystem.theme

import androidx.compose.foundation.layout.Box; import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable; import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf; import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue; import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip; import androidx.compose.ui.draw.drawBehind; import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius; import androidx.compose.ui.geometry.Offset; import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush; import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope; import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration; import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp; import androidx.compose.ui.unit.dp

private fun DrawScope.drawMesh(tokens: GlassTokens, fullSize: Size) {
    drawRect(tokens.meshBase)
    val minDim = minOf(fullSize.width, fullSize.height)
    for (spot in tokens.meshSpots) {
        val c = Offset(spot.xFraction * fullSize.width, spot.yFraction * fullSize.height)
        drawRect(Brush.radialGradient(listOf(spot.color, Color.Transparent), center = c, radius = (spot.radiusFraction * minDim).coerceAtLeast(1f)))
    }
}

@Composable
fun GlassMeshBackground(tokens: GlassTokens, modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxSize().drawBehind { drawMesh(tokens, fullSize = size) })
}

// glassConvex: only translucent tint + gradient border + top highlight + outer shadow, no mesh redraw
@Composable
fun Modifier.glassConvex(cornerRadius: Dp, tokens: GlassTokens = LocalGlassTokens.current): Modifier {
    val rp = with(LocalDensity.current) { cornerRadius.toPx() }
    return this
        .drawBehind { drawRoundRect(tokens.outerShadow, Offset(0f, 2.dp.toPx()), size, CornerRadius(rp, rp)) }
        .clip(RoundedCornerShape(cornerRadius))
        .drawBehind { drawRect(tokens.tintConvex) }
        .drawWithContent { drawContent(); drawRect(tokens.innerHighlight, Size(size.width, 1.dp.toPx())) }
        .drawBehind { drawRoundRect(Brush.linearGradient(listOf(tokens.borderHi, tokens.borderLo)), CornerRadius(rp, rp), style = Stroke(1.dp.toPx())) }
}

// glassConcave: translucent dark tint + gradient border
@Composable
fun Modifier.glassConcave(cornerRadius: Dp, tokens: GlassTokens = LocalGlassTokens.current): Modifier {
    val rp = with(LocalDensity.current) { cornerRadius.toPx() }
    return this
        .clip(RoundedCornerShape(cornerRadius))
        .drawBehind { drawRect(tokens.tintConcave) }
        .drawBehind { drawRoundRect(brush = Brush.linearGradient(listOf(tokens.borderHi, tokens.borderLo)), cornerRadius = CornerRadius(rp, rp), style = Stroke(1.dp.toPx())) }
}

/** Glass raised surface (dialogs/overlays): carries its own mesh, opaque */
@Composable
fun Modifier.glassConvexOverlay(cornerRadius: Dp, tokens: GlassTokens = LocalGlassTokens.current): Modifier {
    var o by remember { mutableStateOf(Offset.Zero) }
    val d = LocalDensity.current; val cfg = LocalConfiguration.current
    val fs = with(d) { Size(cfg.screenWidthDp.dp.toPx(), cfg.screenHeightDp.dp.toPx()) }
    val rp = with(d) { cornerRadius.toPx() }
    return this
        .onGloballyPositioned { o = it.positionInWindow() }
        .drawBehind { drawRoundRect(color = tokens.outerShadow, topLeft = Offset(0f, 2.dp.toPx()), size = size, cornerRadius = CornerRadius(rp, rp)) }
        .clip(RoundedCornerShape(cornerRadius))
        .drawBehind { drawMesh(tokens, fs, o); drawRect(tokens.tintConvex) }
        .drawWithContent { drawContent(); drawRect(color = tokens.innerHighlight, size = Size(size.width, 1.dp.toPx())) }
        .drawBehind { drawRoundRect(brush = Brush.linearGradient(listOf(tokens.borderHi, tokens.borderLo)), cornerRadius = CornerRadius(rp, rp), style = Stroke(1.dp.toPx())) }
}

/** Glass sunken surface (dialogs/overlays): carries its own mesh */
@Composable
fun Modifier.glassConcaveOverlay(cornerRadius: Dp, tokens: GlassTokens = LocalGlassTokens.current): Modifier {
    var o by remember { mutableStateOf(Offset.Zero) }
    val d = LocalDensity.current; val cfg = LocalConfiguration.current
    val fs = with(d) { Size(cfg.screenWidthDp.dp.toPx(), cfg.screenHeightDp.dp.toPx()) }
    val rp = with(d) { cornerRadius.toPx() }
    return this
        .onGloballyPositioned { o = it.positionInWindow() }
        .clip(RoundedCornerShape(cornerRadius))
        .drawBehind { drawMesh(tokens, fs, o); drawRect(tokens.tintConcave) }
        .drawBehind { drawRoundRect(brush = Brush.linearGradient(listOf(tokens.borderHi, tokens.borderLo)), cornerRadius = CornerRadius(rp, rp), style = Stroke(1.dp.toPx())) }
}
```

## Step 16: Dual-engine switching

Update Theme.kt to provide `LocalAppSkin` + `LocalGlassTokens` together, and lay the mesh background when in GLASS mode:

```kotlin
@Composable
fun AppTheme(darkTheme: Boolean = isSystemInDarkTheme(), skin: AppSkin = AppSkin.NEUMORPHISM, content: @Composable () -> Unit) {
    // ... (same colorScheme / hyperColors / transparent status bar logic as Step 13)
    val glassTokens = glassTokensFor(darkTheme)

    CompositionLocalProvider(
        LocalHyperColors provides hyperColors,
        LocalGlassTokens provides glassTokens,
        LocalAppSkin provides skin,
    ) {
        if (skin == AppSkin.GLASS) {
            Box(modifier = Modifier.fillMaxSize()) {
                GlassMeshBackground(glassTokens)
                MaterialTheme(colorScheme = colorScheme, typography = AppTypography, content = { content() })
            }
        } else {
            MaterialTheme(colorScheme = colorScheme, typography = AppTypography, content = content)
        }
    }
}
```

`neumorphicConvex/Concave` in `NeumorphicModifiers.kt` already have the `if (LocalAppSkin.current == AppSkin.GLASS)` branch added in Step 5, routing automatically to `glassConvex/glassConcave`. All components support both skins without modification.

**Switching usage**:
```kotlin
var skin by remember { mutableStateOf(AppSkin.NEUMORPHISM) }
AppTheme(skin = skin) {
    Column {
        NeumorphicSwitch(checked = skin == AppSkin.GLASS, onCheckedChange = {
            skin = if (skin == AppSkin.NEUMORPHISM) AppSkin.GLASS else AppSkin.NEUMORPHISM
        })
        NeumorphicButton("Buttons adapt to the current skin automatically", onClick = {})
        // All components adapt automatically via neumorphicConvex/Concave
    }
}
```

**`isOverlay` usage rules**:
- `isOverlay = false` (default): in-page components (buttons, cards, inputs) — translucent tint in glass mode, global mesh shows through
- `isOverlay = true`: standalone overlays (Dialog, BottomSheet, etc.) — full mesh in glass mode, opaque
- In neumorphic mode `isOverlay` has no effect; both modes render identically

**Haptic feedback**: every interactive component must carry haptics. `NeumorphicButton`/`FAB`/`Checkbox`/`RadioButton`/`Slider`/`Chip`/`Tabs`/`ListItem` use `TextHandleMove`; `NeumorphicSwitch` uses `LongPress`. Implementation: call `haptic.performHapticFeedback()` inside `detectTapGestures.onTap`.

---

## Extended component library

All components below are built on `neumorphicConvex/Concave` and `neumorphicTap`, adapting automatically to both neumorphic/glass skins. When generating real screens, prioritize these controls — don't ship just a minimal Button/Card/Input set.

### Component naming and common APIs

| Type | Naming | Required parameters |
|------|----------|----------|
| Basic actions | `NeumorphicButton` / `NeumorphicIconButton` / `NeumorphicFAB` | `onClick`, `enabled`, `modifier`, `content` or `text` |
| Selection | `NeumorphicCheckbox` / `NeumorphicRadioButton` / `NeumorphicSwitch` | `checked/selected`, `onCheckedChange/onClick`, `label` |
| Input | `NeumorphicInputField` / `NeumorphicPasswordField` / `NeumorphicSearchBar` / `NeumorphicTextArea` | `value`, `onValueChange`, `placeholder`, `enabled`, `isError` |
| Numeric | `NeumorphicSlider` / `NeumorphicRangeSlider` / `NeumorphicStepper` / `NeumorphicRatingBar` | `value`, `valueRange`, `onValueChange` |
| Navigation | `NeumorphicTopAppBar` / `NeumorphicTabs` / `NeumorphicNavigationBar` / `NeumorphicNavigationRail` | `selectedIndex`, `onSelect`, `items` |
| Feedback | `HyperOSDialog` / `NeumorphicBottomSheet` / `NeumorphicSnackbar` / `NeumorphicProgress` | `visible`, `onDismiss`, `state/progress` |
| Data display | `NeumorphicCard` / `NeumorphicListItem` / `NeumorphicGridTile` / `NeumorphicStatisticCard` | `content`, `leading`, `trailing`, `onClick` |

Common requirements:
- Every clickable control must have `enabled`; disabled state uses `alpha(0.48f)` and blocks haptics and click callbacks.
- Every icon button needs a 44dp+ tap target; visual size may be 36-40dp, but the outer `minimumInteractiveComponentSize()` or equivalent padding is mandatory.
- Every input control must support `isError`, `supportingText`, `leadingIcon`, `trailingIcon`; error state only changes text/border/supporting color, never breaks the sunken surface.
- List, navigation, Chip, Tab selected states uniformly use concave or inset highlight; default states use light raised or transparent surfaces.
- Glass-mode overlay controls must pass `isOverlay = true`, e.g. Dialog, BottomSheet, Dropdown, Snackbar.

### Common control coverage matrix

| Category | Required controls | Visual rules |
|------|----------|----------|
| Actions | Button, OutlinedButton, TextButton, IconButton, FAB, SplitButton | Primary actions raised, concave when pressed; secondary actions lower alpha, no extra Material elevation |
| Input | InputField, PasswordField, SearchBar, TextArea | Sunken by default; add a 1dp accent inner stroke or soft glow when focused |
| Numeric | Slider, RangeSlider, Stepper, RatingBar | Concave track, raised thumb; haptics at drag start |
| Selection | Checkbox, RadioButton, Switch, Chip, DropdownMenu, SegmentedControl | Selected = concave or accent fill, unselected = light raised |
| Navigation | TopAppBar, Tabs, NavigationBar, NavigationRail, Breadcrumb, PagerIndicator | Current item clearly raised/concave; unselected distinguished by text color only |
| Display | Card, ListItem, GridTile, Avatar, Badge, Tag, StatisticCard, Timeline | Few container nests; small badges use low-alpha accent backgrounds |
| Feedback | Dialog, BottomSheet, Snackbar, ToastHost, Progress, Spinner, Skeleton, EmptyState, ErrorState | Overlays carry themselves; loading uses low-contrast shimmer |
| Containers | Section, SettingsGroup, ExpandablePanel, Carousel, PullRefreshContainer | No cards inside cards for sections; group entries separated by light dividers or spacing |

### Checkbox
```kotlin
@Composable
fun NeumorphicCheckbox(checked: Boolean, onCheckedChange: (Boolean) -> Unit, label: String = "", modifier: Modifier = Modifier) {
    val colors = LocalHyperColors.current
    val bg by animateColorAsState(if (checked) colors.primary else Color.Transparent, tween(200), label = "cb")
    Row(modifier.neumorphicTap(onClick = { onCheckedChange(!checked) }), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(24.dp).then(if (checked) neumorphicConcave(6.dp, 2.dp) else neumorphicConvex(6.dp, 2.dp)).background(bg, RoundedCornerShape(6.dp)), contentAlignment = Alignment.Center) {
            if (checked) Text("✓", fontSize = 14.sp, fontWeight = FontWeight.Bold, color = colors.background)
        }
        if (label.isNotEmpty()) { Spacer(Modifier.width(10.dp)); Text(label, fontSize = 15.sp, color = colors.textPrimary) }
    }
}
```

### RadioButton + RadioGroup
```kotlin
@Composable
fun NeumorphicRadioButton(selected: Boolean, onClick: () -> Unit, label: String = "") { /* 22dp circle, 10dp center color dot when selected */ }
@Composable
fun NeumorphicRadioGroup(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) { /* vertical stack of RadioButtons */ }
```

### IconButton / ToggleButton / SegmentedControl
```kotlin
@Composable
fun NeumorphicIconButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, selected: Boolean = false, content: @Composable BoxScope.() -> Unit) { /* 44dp tap target, selected/pressed use concave */ }

@Composable
fun NeumorphicToggleButton(checked: Boolean, onCheckedChange: (Boolean) -> Unit, label: String, leadingIcon: (@Composable () -> Unit)? = null) { /* checked = concave + accent text */ }

@Composable
fun NeumorphicSegmentedControl(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) { /* outer concave capsule, raised slider for the selected segment */ }
```

### Progress (Linear / Circular / Spinner)
```kotlin
@Composable
fun NeumorphicLinearProgress(progress: Float, color: Color, trackHeight: Dp = 8.dp, showLabel: Boolean = true) { /* concave track + animateFloatAsState fill */ }
@Composable
fun NeumorphicCircularProgress(progress: Float, size: Dp = 64.dp, color: Color, strokeWidth: Dp = 6.dp) { /* raised circular container + center percentage text */ }
@Composable
fun NeumorphicLoadingSpinner(size: Dp = 40.dp, color: Color) { /* raised circle + Material CircularProgressIndicator */ }
```

### Chip + ChipGroup
```kotlin
@Composable
fun NeumorphicChip(label: String, selected: Boolean, onClick: () -> Unit, leadingIcon: (@Composable () -> Unit)? = null) { /* raised when selected, flat when not + neumorphicTap */ }
@Composable
fun NeumorphicChipGroup(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) { /* horizontal row of Chips */ }
```

### SearchBar / PasswordField / TextArea
```kotlin
@Composable
fun NeumorphicSearchBar(query: String, onQueryChange: (String) -> Unit, placeholder: String = "Search", onClear: (() -> Unit)? = null) { /* leading search icon + trailing clear button + sunken input surface */ }

@Composable
fun NeumorphicPasswordField(value: String, onValueChange: (String) -> Unit, visible: Boolean, onVisibilityChange: (Boolean) -> Unit, isError: Boolean = false) { /* trailing eye IconButton, supports PasswordVisualTransformation */ }

@Composable
fun NeumorphicTextArea(value: String, onValueChange: (String) -> Unit, minLines: Int = 3, maxLines: Int = 6, supportingText: String? = null) { /* auto height, sunken container, supportingText placed outside */ }
```

### Stepper / RangeSlider / RatingBar
```kotlin
@Composable
fun NeumorphicStepper(value: Int, onValueChange: (Int) -> Unit, range: IntRange, step: Int = 1, label: String? = null) { /* minus IconButton + sunken numeric reading + plus IconButton */ }

@Composable
fun NeumorphicRangeSlider(start: Float, end: Float, valueRange: ClosedFloatingPointRange<Float>, onValueChange: (Float, Float) -> Unit) { /* dual thumbs, active range accent fill */ }

@Composable
fun NeumorphicRatingBar(value: Int, onValueChange: (Int) -> Unit, max: Int = 5) { /* horizontal IconButtons, selected accent; switch to Float if half-stars needed */ }
```

### Tabs
```kotlin
@Composable
fun NeumorphicTabs(tabs: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) { /* whole container concave, selected tab raised + neumorphicTap */ }
```

### TopAppBar / NavigationBar / NavigationRail
```kotlin
data class NeumorphicNavItem(val label: String, val icon: @Composable () -> Unit, val badge: String? = null)

@Composable
fun NeumorphicTopAppBar(title: String, navigationIcon: (@Composable () -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}) { /* transparent background + light bottom shadow or embossed divider */ }

@Composable
fun NeumorphicNavigationBar(items: List<NeumorphicNavItem>, selectedIndex: Int, onSelect: (Int) -> Unit) { /* bottom raised container, selected item concave capsule */ }

@Composable
fun NeumorphicNavigationRail(items: List<NeumorphicNavItem>, selectedIndex: Int, onSelect: (Int) -> Unit) { /* 72dp wide, vertical options, selected concave rounded */ }
```

### ListItem / Divider
```kotlin
@Composable
fun NeumorphicListItem(headline: String, supporting: String?, leading/trailing slots, onClick: (() -> Unit)?) { /* Row + neumorphicTap */ }
@Composable
fun NeumorphicDivider() { /* 1dp divider-color horizontal line, 16dp padding on both sides */ }
```

### DropdownMenu / Tooltip / Snackbar
```kotlin
@Composable
fun NeumorphicDropdownMenu(expanded: Boolean, onDismiss: () -> Unit, items: List<String>, onSelect: (Int) -> Unit) { /* Popup/Dialog overlay, pass isOverlay=true in glass mode */ }

@Composable
fun NeumorphicTooltip(visible: Boolean, text: String, anchor: @Composable () -> Unit) { /* small raised overlay, 12dp radius, never competes with primary hierarchy */ }

@Composable
fun NeumorphicSnackbar(message: String, actionText: String? = null, onAction: (() -> Unit)? = null, onDismiss: () -> Unit) { /* bottom overlay, raised container + optional action */ }
```

### Avatar / Badge
```kotlin
@Composable
fun NeumorphicAvatar(content: @Composable () -> Unit, size: Dp = 44.dp) { /* circular neumorphicConvex container */ }
@Composable
fun NeumorphicBadge(text: String, color: Color) { /* 10dp raised radius + 12% color background + color text */ }
```

### StatisticCard / Timeline / GridTile
```kotlin
@Composable
fun NeumorphicStatisticCard(title: String, value: String, delta: String? = null, icon: (@Composable () -> Unit)? = null) { /* large number + supporting trend, for dashboards */ }

@Composable
fun NeumorphicTimeline(items: List<TimelineItem>) { /* left dots raised + vertical line, right content cards */ }

@Composable
fun NeumorphicGridTile(title: String, subtitle: String? = null, icon: (@Composable () -> Unit)? = null, onClick: (() -> Unit)? = null) { /* fixed aspectRatio to avoid grid jumping */ }
```

### EmptyState
```kotlin
@Composable
fun NeumorphicEmptyState(icon: String = "📭", title: String, subtitle: String, action: (@Composable () -> Unit)?) { /* centered Column: 72dp icon circle + title + description + action */ }

@Composable
fun NeumorphicErrorState(title: String, subtitle: String, retryText: String = "Retry", onRetry: (() -> Unit)? = null) { /* error icon circle + copy + optional retry button */ }
```

### Skeleton (loading placeholder)
```kotlin
@Composable
fun NeumorphicSkeleton(width: Dp, height: Dp, cornerRadius: Dp) { /* rememberInfiniteTransition + shimmer gradient */ }
@Composable
fun NeumorphicSkeletonList(lines: Int) { /* skeleton list of avatar circle + text lines */ }
```

### FAB (floating action button)
```kotlin
@Composable
fun NeumorphicFAB(onClick: () -> Unit, size: Dp = 56.dp, content: @Composable () -> Unit) { /* raised circle, 4dp elevation */ }
```

### BottomSheet (bottom panel)
```kotlin
@Composable
fun NeumorphicBottomSheet(visible: Boolean, onDismiss: () -> Unit, title: String, content: @Composable ColumnScope.() -> Unit) { /* Dialog + wrapContentHeight + neumorphicConvex + drag handle */ }
```

### DatePicker / TimePicker
```kotlin
@Composable
fun NeumorphicDatePicker(selectedDateMillis: Long?, onDateSelected: (Long) -> Unit, onDismiss: () -> Unit) { /* month navigation IconButtons + date grid, selected date concave */ }

@Composable
fun NeumorphicTimePicker(hour: Int, minute: Int, onTimeChange: (Int, Int) -> Unit, onDismiss: () -> Unit) { /* hour/minute Stepper or dial, number items keep 44dp tap targets */ }
```

### PullRefresh / Carousel / ExpandablePanel
```kotlin
@Composable
fun NeumorphicPullRefreshContainer(isRefreshing: Boolean, onRefresh: () -> Unit, content: @Composable () -> Unit) { /* prefer Material pullRefresh state, raised circle indicator */ }

@Composable
fun NeumorphicCarousel(pageCount: Int, currentPage: Int, content: @Composable (Int) -> Unit) { /* horizontal Pager + PagerIndicator, fixed card width/height */ }

@Composable
fun NeumorphicExpandablePanel(title: String, expanded: Boolean, onExpandedChange: (Boolean) -> Unit, content: @Composable ColumnScope.() -> Unit) { /* clickable header, expanded content with AnimatedVisibility */ }
```

### Accessibility and state checklist

- `contentDescription`: mandatory for pure icon actions; decorative icons pass `null`.
- `semantics`: Checkbox/Radio/Switch/Slider/Tab must expose selected/checked/progress semantics.
- `minimumInteractiveComponentSize`: icons, Chips, Tabs, date cells no smaller than 44dp.
- `enabled/loading/error/selected/focused/pressed`: components must cover the relevant ones of these states.
- `rememberSaveable`: prefer saveable state for inputs, Tabs, and filter conditions in example screens.

---

## Prohibitions and cautions

- **Don't use Material default `ElevationCard` / `Surface` elevation**
- **Don't use `ripple()` indication** — use `indication = null`
- **Don't use `Modifier.background()` to overlay colors on non-raised/sunken surfaces** — it breaks the embossed shadows
- **Short-press animation uses `detectTapGestures`, not `MutableInteractionSource`** — the latter lags on rapid taps
- **Shadow pairs auto-switch in dark mode** (`NeumDarkLight`/`NeumDarkDark`)
- **`Animatable.snapTo` for the press instant, `animateTo` for the release spring-back**
