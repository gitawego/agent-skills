---
name: neumorphism
description: Pure neumorphism (Soft UI) design system — a complete Android Jetpack Compose UI kit. Classic embossed style: soft dual-tone shadows, raised/sunken buttons, borderless cards, minimal palette. Includes the BlurMaskFilter dual-tone light engine, light/dark auto-adaptation, press-in concave animation, haptic feedback, corner-radius system, and adaptation rules for Button/Input/SearchBar/NavigationBar/Dialog/BottomSheet/DatePicker and other common controls.
---

# Neumorphism — Pure Soft UI Design System

An Android Jetpack Compose classic neumorphism (Soft UI) design system. Surfaces blend into the background through soft embossing, with light/dark dual-tone shadows simulating raised and sunken states.

## Design characteristics

- **Dual-tone light engine**: `BlurMaskFilter`-driven top-left bright highlight + bottom-right dark shadow
- **Extreme softness**: shadow colors are derived from the background color, so components blend perfectly with the background ("background-colored" aesthetic)
- **Light/dark auto-adaptation**: bright/dark shadow pairs are computed automatically from the background color
- **Press-in feedback**: buttons switch convex → concave on press, restore on release
- **Haptic feedback**: standard `TextHandleMove` / `LongPress` haptics
- **Clean visuals**: no outlines, no dividers, no ripples — hierarchy is expressed purely with shadows
- **Corner-radius system**: outer 24dp → middle 18dp → inner 12dp

## When to use

This skill is designed for **new Android Jetpack Compose projects**. Use it when the user asks for:
- "Build a neumorphic design system"
- "Use a Soft UI style"
- "Make an embossed/relief-style Android UI"
- "Don't use Material Design — I want a soft neumorphic look"

## File structure

```
ui/designsystem/
├── theme/
│   ├── NeumColors.kt        ← Neumorphic palette + shadow colors
│   ├── NeumTypography.kt    ← Typography
│   ├── NeumSpacing.kt       ← Spacing / corner radii
│   ├── NeumShadows.kt       ← convex/concave shadow Modifiers
│   └── NeumTheme.kt         ← Root theme
├── token/
│   └── NeumInteractions.kt  ← Tap interaction (light/shadow linkage + scale)
└── component/
    ├── NeumButton.kt        ← Button
    ├── NeumCard.kt          ← Card
    ├── NeumSwitch.kt        ← Switch
    ├── NeumSlider.kt        ← Slider
    ├── NeumInput.kt         ← Input field
    └── NeumDialog.kt        ← Dialog
```

---

## Step 1: Dependencies

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

---

## Step 2: NeumColors.kt

```kotlin
package com.example.app.designsystem.theme

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Neumorphic palette — key idea: every color is derived from the background
 */
data class NeumColors(
    val background: Color,
    val surface: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textTertiary: Color,
    val accent: Color,
    val success: Color,
    val warning: Color,
    val error: Color,
)

// ═══ Light palette (soft warm gray) ═══
val LightNeumColors = NeumColors(
    background = Color(0xFFEEF0F4),
    surface = Color(0xFFEEF0F4),
    textPrimary = Color(0xFF2D3436),
    textSecondary = Color(0xFF636E72),
    textTertiary = Color(0xFFB2BEC3),
    accent = Color(0xFF6C5CE7),
    success = Color(0xFF00B894),
    warning = Color(0xFFFDCB6E),
    error = Color(0xFFFF7675),
)

// ═══ Dark palette ═══
val DarkNeumColors = NeumColors(
    background = Color(0xFF1E1F26),
    surface = Color(0xFF1E1F26),
    textPrimary = Color(0xFFF0F0F3),
    textSecondary = Color(0xFFA0A3B1),
    textTertiary = Color(0xFF5A5D6E),
    accent = Color(0xFFA29BFE),
    success = Color(0xFF55EFC4),
    warning = Color(0xFFFFEAA7),
    error = Color(0xFFFF8A80),
)

val LocalNeumColors = staticCompositionLocalOf { LightNeumColors }
```

---

## Step 3: NeumTypography.kt

```kotlin
package com.example.app.designsystem.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val NeumTypography = Typography(
    displayLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Bold, fontSize = 34.sp, letterSpacing = 0.sp),
    headlineLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Bold, fontSize = 28.sp, letterSpacing = 0.sp),
    headlineMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 24.sp, letterSpacing = 0.sp),
    titleLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, letterSpacing = 0.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 16.sp, letterSpacing = 0.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp, letterSpacing = 0.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Normal, fontSize = 14.sp, letterSpacing = 0.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 14.sp, letterSpacing = 0.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 12.sp, letterSpacing = 0.sp),
)
```

---

## Step 4: NeumSpacing.kt

```kotlin
package com.example.app.designsystem.theme

import androidx.compose.ui.unit.dp

object NeumSpacing {
    val screenPadding = 20.dp
    val cardGap = 16.dp
    val cardCorner = 24.dp        // Outer card
    val innerCorner = 18.dp       // Inner area
    val elementCorner = 12.dp     // Small elements
    val buttonHeight = 56.dp
    val buttonCorner = 16.dp
    val inputHeight = 56.dp
    val chipHeight = 36.dp
    val switchWidth = 56.dp
    val switchHeight = 30.dp
    val elementPadding = 16.dp
}
```

---

## Step 5: NeumShadows.kt — the core engine

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

/** Derive light/dark shadow colors from the background color */
private fun deriveShadowColors(bg: Color): Pair<Color, Color> {
    // Decide light vs dark by luminance
    val luminance = 0.299f * bg.red + 0.587f * bg.green + 0.114f * bg.blue
    return if (luminance > 0.5f) {
        // Light background: pure white highlight + cool gray shadow
        Color(0xFFFFFFFF) to Color(0xFFC8CDD8)
    } else {
        // Dark background: slightly bright highlight + very dark shadow
        Color(0xFF2E303A) to Color(0xFF0A0A0F)
    }
}

/**
 * Raised embossed surface (convex)
 * Top-left bright + bottom-right dark → appears to float above the background
 */
@Composable
fun Modifier.neumConvex(
    cornerRadius: Dp = 24.dp,
    elevation: Dp = 8.dp,
    bgColor: Color? = null,
): Modifier {
    val bg = bgColor ?: LocalNeumColors.current.background
    val (light, dark) = deriveShadowColors(bg)

    return this
        .clip(RoundedCornerShape(cornerRadius))
        .background(bg)
        .drawBehind {
            drawIntoCanvas { canvas ->
                val paint = Paint().apply {
                    asFrameworkPaint().apply {
                        isAntiAlias = true
                        maskFilter = BlurMaskFilter(elevation.toPx(), BlurMaskFilter.Blur.NORMAL)
                    }
                }

                // Bottom-right dark shadow
                paint.color = dark
                val d = elevation.toPx()
                canvas.drawRoundRect(
                    d * 0.5f, d * 0.5f,
                    size.width + d * 0.5f, size.height + d * 0.5f,
                    cornerRadius.toPx(), cornerRadius.toPx(),
                    paint
                )

                // Top-left highlight
                paint.color = light
                canvas.drawRoundRect(
                    -d * 0.5f, -d * 0.5f,
                    size.width - d * 0.5f, size.height - d * 0.5f,
                    cornerRadius.toPx(), cornerRadius.toPx(),
                    paint
                )
            }
        }
}

/**
 * Sunken embossed surface (concave)
 * Top-left dark inner shadow + bottom-right bright inner shadow → appears pressed into the background
 */
@Composable
fun Modifier.neumConcave(
    cornerRadius: Dp = 24.dp,
    elevation: Dp = 4.dp,
    bgColor: Color? = null,
): Modifier {
    val bg = bgColor ?: LocalNeumColors.current.background
    val (light, dark) = deriveShadowColors(bg)

    return this
        .clip(RoundedCornerShape(cornerRadius))
        .background(bg)
        .drawWithContent {
            drawIntoCanvas { canvas ->
                val ep = elevation.toPx()
                val blur = BlurMaskFilter(ep, BlurMaskFilter.Blur.NORMAL)

                // Top-left dark inner shadow
                val darkP = Paint().apply {
                    color = dark.copy(alpha = 0.7f)
                    asFrameworkPaint().apply {
                        isAntiAlias = true; maskFilter = blur
                        style = android.graphics.Paint.Style.STROKE; strokeWidth = ep * 2f
                    }
                }
                canvas.drawRoundRect(
                    -ep * 0.5f, -ep * 0.5f, size.width, size.height,
                    cornerRadius.toPx(), cornerRadius.toPx(), darkP
                )

                // Bottom-right bright inner shadow
                val lightP = Paint().apply {
                    color = light
                    asFrameworkPaint().apply {
                        isAntiAlias = true; maskFilter = blur
                        style = android.graphics.Paint.Style.STROKE; strokeWidth = ep * 2f
                    }
                }
                canvas.drawRoundRect(
                    0f, 0f, size.width + ep * 0.5f, size.height + ep * 0.5f,
                    cornerRadius.toPx(), cornerRadius.toPx(), lightP
                )
            }
            drawContent()
        }
}
```

---

## Step 6: NeumInteractions.kt — tap interaction

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
import com.example.app.designsystem.theme.neumConcave
import com.example.app.designsystem.theme.neumConvex
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Neumorphic tap: scale + haptics + light/shadow linkage
 * Uses detectTapGestures so both short taps and long presses animate.
 * Press: scale 0.96 + concave; release: scale 1.0 + convex
 */
@Composable
fun Modifier.neumClickable(
    enabled: Boolean = true,
    cornerRadius: Dp = 24.dp,
    elevation: Dp = 6.dp,
    onClick: () -> Unit,
): Modifier {
    val haptic = LocalHapticFeedback.current
    var isPressed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val scaleAnim = remember { Animatable(1f) }

    return this
        .scale(scaleAnim.value)
        .then(
            if (isPressed && enabled) neumConcave(cornerRadius, elevation / 2)
            else neumConvex(cornerRadius, elevation)
        )
        .pointerInput(enabled) {
            if (enabled) detectTapGestures(
                onPress = {
                    isPressed = true
                    scope.launch { scaleAnim.snapTo(0.96f) }
                    tryAwaitRelease()
                    isPressed = false
                    scope.launch { delay(50); scaleAnim.animateTo(1f, tween(180, easing = FastOutSlowInEasing)) }
                },
                onTap = { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() }
            )
        }
}
```

---

## Step 7: NeumButton.kt

```kotlin
package com.example.app.designsystem.component

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.app.designsystem.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun NeumButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isLoading: Boolean = false,
    height: Dp = 56.dp,
    cornerRadius: Dp = 16.dp,
    icon: (@Composable () -> Unit)? = null,
) {
    val colors = LocalNeumColors.current
    val haptic = LocalHapticFeedback.current
    var isPressed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val scaleAnim = remember { Animatable(1f) }

    fun pressDown() { isPressed = true; scope.launch { scaleAnim.snapTo(0.96f) } }
    fun pressUp() { isPressed = false; scope.launch { delay(50); scaleAnim.animateTo(1f, tween(200, easing = FastOutSlowInEasing)) } }

    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .height(height)
            .scale(scaleAnim.value)
            .then(
                if (isPressed && enabled) neumConcave(cornerRadius, elevation = 3.dp)
                else neumConvex(cornerRadius, elevation = 6.dp)
            )
            .clip(RoundedCornerShape(cornerRadius))
            .pointerInput(enabled) {
                if (enabled && !isLoading) detectTapGestures(
                    onPress = { pressDown(); tryAwaitRelease(); pressUp() },
                    onTap = { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() }
                )
            }
            .padding(horizontal = 28.dp)
    ) {
        if (isLoading) {
            CircularProgressIndicator(
                modifier = Modifier.size(24.dp),
                color = colors.accent,
                strokeWidth = 2.dp
            )
        } else if (icon != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                icon()
                Spacer(Modifier.width(8.dp))
                Text(text, color = colors.accent, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            }
        } else {
            Text(text, color = colors.accent, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}
```

---

## Step 8: NeumCard.kt

```kotlin
package com.example.app.designsystem.component

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.example.app.designsystem.theme.neumConvex

@Composable
fun NeumCard(
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 24.dp,
    elevation: Dp = 8.dp,
    padding: Dp = 20.dp,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = modifier
            .neumConvex(cornerRadius = cornerRadius, elevation = elevation)
            .padding(padding),
        content = { content() }
    )
}
```

---

## Step 9: NeumSwitch.kt

```kotlin
package com.example.app.designsystem.component

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
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
import com.example.app.designsystem.theme.LocalNeumColors
import com.example.app.designsystem.theme.neumConcave
import com.example.app.designsystem.theme.neumConvex

@Composable
fun NeumSwitch(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val haptic = LocalHapticFeedback.current
    val colors = LocalNeumColors.current

    val thumbOffset by animateDpAsState(
        targetValue = if (checked) 26.dp else 4.dp,
        animationSpec = tween(250, easing = FastOutSlowInEasing),
        label = "thumb"
    )

    val trackColor by animateColorAsState(
        targetValue = if (checked) colors.accent else Color.Transparent,
        animationSpec = tween(250),
        label = "track"
    )

    Box(
        modifier = modifier
            .width(56.dp).height(30.dp)
            .neumConcave(cornerRadius = 15.dp, elevation = 2.dp)
            .background(trackColor, RoundedCornerShape(15.dp))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null
            ) {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onCheckedChange(!checked)
            }
    ) {
        Box(
            modifier = Modifier
                .offset(x = thumbOffset)
                .align(Alignment.CenterStart)
                .size(22.dp)
                .neumConvex(cornerRadius = 11.dp, elevation = 2.dp)
        )
    }
}
```

---

## Step 10: NeumSlider.kt

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
import com.example.app.designsystem.theme.LocalNeumColors
import com.example.app.designsystem.theme.neumConcave
import com.example.app.designsystem.theme.neumConvex

@Composable
fun NeumSlider(
    value: Float,
    valueRange: ClosedFloatingPointRange<Float>,
    onValueChange: (Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalNeumColors.current
    val range = valueRange.endInclusive - valueRange.start
    val fraction = ((value - valueRange.start) / range).coerceIn(0f, 1f)
    val currentOnValueChange by rememberUpdatedState(onValueChange)

    BoxWithConstraints(
        modifier = modifier.fillMaxWidth().height(36.dp),
        contentAlignment = Alignment.CenterStart
    ) {
        val widthPx = constraints.maxWidth.toFloat()
        val thumbR = 18.dp; val thumbRPx = with(LocalDensity.current) { thumbR.toPx() }
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
            Box(
                modifier = Modifier.fillMaxWidth().height(10.dp)
                    .neumConcave(cornerRadius = 5.dp, elevation = 2.dp)
            ) {
                Box(
                    modifier = Modifier.fillMaxHeight().fillMaxWidth(fraction)
                        .background(colors.accent.copy(alpha = 0.7f), RoundedCornerShape(5.dp))
                )
            }

            val thumbPx = fraction * maxDragPx
            val thumbDp = with(LocalDensity.current) { thumbPx.toDp() }
            Box(
                modifier = Modifier.offset(x = thumbDp).size(thumbR * 2)
                    .neumConvex(cornerRadius = thumbR, elevation = 3.dp),
                contentAlignment = Alignment.Center
            ) {
                Box(Modifier.size(8.dp).background(colors.accent, CircleShape))
            }
        }
    }
}
```

---

## Step 11: NeumInput.kt

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
import com.example.app.designsystem.theme.LocalNeumColors
import com.example.app.designsystem.theme.neumConcave

@Composable
fun NeumInput(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    leadingIcon: @Composable (() -> Unit)? = null,
    isFocused: Boolean = false,
) {
    val colors = LocalNeumColors.current

    Box(
        modifier = modifier
            .height(56.dp).fillMaxWidth()
            .neumConcave(cornerRadius = 16.dp, elevation = 2.dp)
            .then(
                if (isFocused) Modifier.border(1.5.dp, colors.accent, RoundedCornerShape(16.dp))
                else Modifier
            )
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (leadingIcon != null) { leadingIcon(); Spacer(Modifier.width(10.dp)) }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier.weight(1f),
                textStyle = LocalTextStyle.current.copy(color = colors.textPrimary, fontSize = 16.sp),
                decorationBox = { inner ->
                    if (value.isEmpty()) Text(placeholder, color = colors.textTertiary, fontSize = 16.sp)
                    inner()
                }
            )
        }
    }
}
```

---

## Step 12: NeumDialog.kt

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
import com.example.app.designsystem.theme.LocalNeumColors
import com.example.app.designsystem.theme.neumConvex

@Composable
fun NeumDialog(
    title: String,
    message: String,
    confirmText: String = "Confirm",
    cancelText: String = "Cancel",
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    val colors = LocalNeumColors.current

    Dialog(
        onDismissRequest = onCancel,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Box(
            modifier = Modifier
                .width(300.dp).wrapContentHeight()
                .neumConvex(cornerRadius = 24.dp, elevation = 10.dp)
                .padding(top = 28.dp, bottom = 20.dp, start = 24.dp, end = 24.dp),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(title, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = colors.textPrimary)
                Spacer(Modifier.height(12.dp))
                Text(message, fontSize = 14.sp, lineHeight = 20.sp, color = colors.textSecondary, textAlign = TextAlign.Center)
                Spacer(Modifier.height(24.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    NeumButton(
                        text = cancelText,
                        onClick = onCancel,
                        modifier = Modifier.weight(1f),
                        height = 48.dp,
                        cornerRadius = 14.dp
                    )
                    NeumButton(
                        text = confirmText,
                        onClick = onConfirm,
                        modifier = Modifier.weight(1f),
                        height = 48.dp,
                        cornerRadius = 14.dp
                    )
                }
            }
        }
    }
}
```

---

## Step 13: NeumTheme.kt — root theme

```kotlin
package com.example.app.designsystem.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

@Composable
fun NeumTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val neumColors = if (darkTheme) DarkNeumColors else LightNeumColors

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = neumColors.background.toArgb()
            window.navigationBarColor = neumColors.background.toArgb()
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }

    CompositionLocalProvider(LocalNeumColors provides neumColors) {
        MaterialTheme(
            colorScheme = MaterialTheme.colorScheme.copy(
                background = neumColors.background,
                surface = neumColors.surface,
                onBackground = neumColors.textPrimary,
                onSurface = neumColors.textPrimary,
                primary = neumColors.accent,
            ),
            typography = NeumTypography,
            content = content,
        )
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
            NeumTheme {
                val colors = LocalNeumColors.current
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = colors.background
                ) {
                    LazyColumn(
                        modifier = Modifier.padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp)
                    ) {
                        // Raised card
                        item {
                            NeumCard(modifier = Modifier.fillMaxWidth().height(100.dp)) {
                                Text("Neumorphic Card", style = MaterialTheme.typography.titleLarge)
                            }
                        }

                        // Button
                        item { NeumButton(text = "Primary Action", onClick = { /* ... */ }, modifier = Modifier.fillMaxWidth()) }

                        // Switch
                        item {
                            var checked by remember { mutableStateOf(false) }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("Switch", modifier = Modifier.weight(1f))
                                NeumSwitch(checked = checked, onCheckedChange = { checked = it })
                            }
                        }

                        // Slider
                        item {
                            var sliderValue by remember { mutableFloatStateOf(50f) }
                            NeumSlider(
                                value = sliderValue,
                                valueRange = 0f..100f,
                                onValueChange = { sliderValue = it },
                                modifier = Modifier.fillMaxWidth()
                            )
                        }

                        // Input field
                        item {
                            var text by remember { mutableStateOf("") }
                            NeumInput(value = text, onValueChange = { text = it }, placeholder = "Type something...", modifier = Modifier.fillMaxWidth())
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

| Property | Light | Dark |
|------|------|------|
| Background | `#EEF0F4` | `#1E1F26` |
| Light shadow | `#FFFFFF` | `#2E303A` |
| Dark shadow | `#C8CDD8` | `#0A0A0F` |
| Accent | `#6C5CE7` | `#A29BFE` |
| Button corner | 16dp | 16dp |
| Card corner | 24dp | 24dp |
| Convex elevation | 6-8dp | 6-8dp |
| Concave elevation | 2-4dp | 2-4dp |
| Button scale | 0.96 | 0.96 |
| Animation duration | 180-250ms | 180-250ms |

---

## Extended components

All extended components are built on `neumConvex/Concave` + `neumClickable/neumTap`. The core pattern is consistent: raised = default, sunken = pressed/selected/input.

### Required control checklist

The pure neumorphism skill must cover at least the controls below. API naming uses the `Neum*` prefix, with parameters isomorphic to the `Neumorphic*` equivalents in `hyper-neumorphic` for easy migration.

| Category | Controls | Neumorphic implementation notes |
|------|------|----------------|
| Actions | Button, IconButton, FAB, SplitButton, ToggleButton, SegmentedControl | Raised by default, concave when pressed/selected; disabled alpha 0.48 |
| Input | Input, PasswordInput, SearchBar, TextArea | Concave container, accent inner highlight when focused, error state doesn't change elevation |
| Numeric | Slider, RangeSlider, Stepper, RatingBar | Concave track, raised thumb/buttons, haptics at drag start |
| Selection | Checkbox, RadioButton, Switch, Chip, DropdownMenu, DatePicker, TimePicker | Selected = concave or accent fill, unselected = light raised |
| Navigation | TopAppBar, Tabs, NavigationBar, NavigationRail, Breadcrumb, PagerIndicator | Current item uses concave capsule or raised slider, unselected items dim the text color |
| Display | Card, ListItem, GridTile, StatisticCard, Timeline, Avatar, Badge, Tag, Tooltip | Same color as background; hierarchy via shadows and spacing |
| Feedback | Dialog, BottomSheet, Snackbar, ToastHost, Progress, Spinner, Skeleton, EmptyState, ErrorState | Overlays ride on raised surfaces; progress and skeletons use low-contrast animation |
| Containers | Section, SettingsGroup, ExpandablePanel, Carousel, PullRefreshContainer | Avoid cards inside cards; express structure with spacing, indentation, and light dividers |

### Checkbox / RadioButton / Progress / Chip / Tabs / ListItem / Avatar / Badge / EmptyState / Skeleton / FAB / BottomSheet

Full implementations are in the `hyper-neumorphic` skill's "Extended component library" section. Key patterns:

| Component | Core Modifier | Key interaction |
|------|-------------|---------|
| Checkbox | 24dp raised/concave toggle with 6dp radius | neumorphicTap + animateColorAsState |
| RadioButton | 22dp raised circle, 10dp inner color dot | clickable + animateColorAsState |
| LinearProgress | Concave track + tinted fill | animateFloatAsState |
| CircularProgress | Raised circular container | animateFloatAsState |
| Chip | Raised when selected / flat when not, 16dp radius | neumorphicTap |
| Tabs | Whole container concave + selected tab raised | neumorphicTap |
| ListItem | Row + optional neumorphicTap | with headline/supporting/leading/trailing |
| Avatar | Circular neumorphicConvex | content centered |
| Badge | 10dp raised + 12% color background | small text label |
| EmptyState | Centered Column + icon circle | optional action button |
| Skeleton | Concave + shimmer gradient animation | rememberInfiniteTransition |
| FAB | 56dp raised circle | clickable |
| BottomSheet | Dialog + neumorphicConvex + drag handle | slides from bottom |

### Additional common control patterns

| Control | Core Modifier | Key interaction |
|------|-------------|---------|
| IconButton | 44dp tap target + circular raised/concave | icon must have contentDescription |
| ToggleButton | concave when checked + accent text | neumTap + animateColorAsState |
| SegmentedControl | outer concave capsule + raised selected slider | animated selection index |
| SearchBar | leading search icon + trailing clear button | input surface concave, clear button raised |
| PasswordInput | trailing visibility IconButton | PasswordVisualTransformation |
| TextArea | minLines/maxLines + supportingText | auto height; supporting text outside the container |
| RangeSlider | concave track + dual raised thumbs | active range accent fill |
| Stepper | minus button + concave value + plus button | buttons disabled at range bounds |
| RatingBar | horizontal row of IconButtons | selected accent, unselected tertiary |
| TopAppBar | transparent background + light embossed bottom divider | navigation/actions use IconButton |
| NavigationBar | bottom raised container | selected item concave capsule |
| NavigationRail | 72dp sidebar raised container | selected item concave rounded |
| DropdownMenu | Popup/overlay raised container | dismiss on outside tap |
| Tooltip | small raised overlay | 12dp radius, short text |
| Snackbar | bottom raised overlay | optional action button |
| StatisticCard | Card + large number + delta | first choice for dashboards |
| Timeline | left raised node + vertical line | right content lightly raised |
| GridTile | fixed aspectRatio card | avoid grid height jumping |
| DatePicker | month navigation + date grid | selected date concave |
| TimePicker | Stepper or dial | number items 44dp tap targets |
| PullRefreshContainer | raised refresh indicator circle | reuse pullRefresh state |
| Carousel | HorizontalPager + PagerIndicator | fixed card width/height |
| ExpandablePanel | clickable header + AnimatedVisibility | expanded content not wrapped in another card |

### States and accessibility

- Every interactive component provides `enabled`; disabled components don't trigger haptics.
- Icon-only actions must provide `contentDescription`; decorative icons use `null`.
- Checkbox, Radio, Switch, Slider, Tab, Navigation items add the corresponding semantics.
- Small controls may be visually smaller than 44dp, but the tap target must never be smaller than 44dp.
- `loading/error/selected/focused/pressed` states must be represented in the control API or examples.


## Prohibitions and cautions

- **The background color must stay uniform**: all raised/sunken surfaces use the exact same background color
- **Don't mix Material elevation with neumorphism**
- **Short-press animation uses `detectTapGestures`, not `MutableInteractionSource`**
- **Elevation shouldn't be excessive**: 6-8dp is the sweet spot
- **Haptic feedback**: every interactive component needs `haptic.performHapticFeedback()`. Button/FAB/Checkbox/Radio/Slider/Chip/Tabs/ListItem use `TextHandleMove`; Switch uses `LongPress`
