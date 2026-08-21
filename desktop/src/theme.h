// The app's visual system, following the design language of vufh.dev.
//
// Four ideas carry it:
//
//   * **Pure black ground.** Not dark grey — #000000, so everything above it
//     is a light source rather than a lighter box.
//   * **Surfaces are translucent white, not opaque colour.** A panel is the
//     ground plus 3.5% white; its edge is the ground plus 9%. One neutral
//     ramp, no hue anywhere in the chrome.
//   * **No accent colour.** Primary means white-on-black, inverted. The only
//     colour in the whole interface is a seven-stop spectrum, spent on the
//     mark and the working indicator and nothing else.
//   * **Small, quiet type.** 15px body, 300 weight for anything large, and
//     hover states that dim rather than brighten.
//
// Semantic colours are drawn from the spectrum's own stops, so even the error
// red belongs to the palette rather than arriving from a stock UI kit.
#pragma once

#include "imgui.h"

namespace dc::theme {

// ---- ground -----------------------------------------------------------------
inline const ImVec4 kCanvas{0.0f, 0.0f, 0.0f, 1.0f};
/// The sidebar is the same black; only a hairline separates it.
inline const ImVec4 kSidebar{0.0f, 0.0f, 0.0f, 1.0f};

// ---- surfaces, as white laid over the ground --------------------------------
inline const ImVec4 kSurfaceFaint{1.0f, 1.0f, 1.0f, 0.020f};
inline const ImVec4 kSurface{1.0f, 1.0f, 1.0f, 0.035f};
inline const ImVec4 kSurfaceHover{1.0f, 1.0f, 1.0f, 0.060f};
inline const ImVec4 kSurfaceActive{1.0f, 1.0f, 1.0f, 0.090f};

// ---- lines ------------------------------------------------------------------
inline const ImVec4 kBorder{1.0f, 1.0f, 1.0f, 0.090f};
inline const ImVec4 kBorderStrong{1.0f, 1.0f, 1.0f, 0.160f};

// ---- text, a pure neutral ramp ----------------------------------------------
inline const ImVec4 kText{0.961f, 0.961f, 0.961f, 1.0f};      // #f5f5f5
inline const ImVec4 kTextSoft{0.812f, 0.812f, 0.812f, 1.0f};  // #cfcfcf
inline const ImVec4 kTextMuted{0.541f, 0.541f, 0.541f, 1.0f}; // #8a8a8a
inline const ImVec4 kTextFaint{0.361f, 0.361f, 0.361f, 1.0f}; // #5c5c5c

// ---- "accent" is the absence of one: white, inverted -------------------------
inline const ImVec4 kAccent{0.961f, 0.961f, 0.961f, 1.0f};
inline const ImVec4 kAccentHover{1.0f, 1.0f, 1.0f, 1.0f};
/// Text drawn on top of a white fill.
inline const ImVec4 kOnAccent{0.0f, 0.0f, 0.0f, 1.0f};
/// Focus is a white hairline held off the control, never a colour.
inline const ImVec4 kFocusRing{1.0f, 1.0f, 1.0f, 0.55f};

// ---- semantics, taken from the spectrum's own stops -------------------------
inline const ImVec4 kDanger{1.0f, 0.302f, 0.302f, 1.0f};   // #ff4d4d
inline const ImVec4 kWarning{1.0f, 0.651f, 0.302f, 1.0f};  // #ffa64d
inline const ImVec4 kSuccess{0.302f, 1.0f, 0.533f, 1.0f};  // #4dff88
inline const ImVec4 kInfo{0.302f, 0.824f, 1.0f, 1.0f};     // #4dd2ff

/// The seven-stop spectrum, with the positions it is interpolated across.
inline constexpr int kSpectrumCount = 7;
inline const ImVec4 kSpectrum[kSpectrumCount] = {
    {1.000f, 0.302f, 0.302f, 1.0f}, // #ff4d4d
    {1.000f, 0.651f, 0.302f, 1.0f}, // #ffa64d
    {1.000f, 0.882f, 0.302f, 1.0f}, // #ffe14d
    {0.302f, 1.000f, 0.533f, 1.0f}, // #4dff88
    {0.302f, 0.824f, 1.000f, 1.0f}, // #4dd2ff
    {0.478f, 0.361f, 1.000f, 1.0f}, // #7a5cff
    {1.000f, 0.361f, 0.784f, 1.0f}, // #ff5cc8
};
inline const float kSpectrumStops[kSpectrumCount] = {0.00f, 0.16f, 0.32f, 0.50f,
                                                     0.66f, 0.83f, 1.00f};

/// Paints the spectrum left-to-right across the rectangle.
void drawSpectrum(ImDrawList* draw, const ImVec2& min, const ImVec2& max, float alpha = 1.0f);

// ---- spacing, on a 4pt grid -------------------------------------------------
inline constexpr float kSpace1 = 4.0f;
inline constexpr float kSpace2 = 8.0f;
inline constexpr float kSpace3 = 12.0f;
inline constexpr float kSpace4 = 16.0f;
inline constexpr float kSpace5 = 24.0f;
inline constexpr float kSpace6 = 32.0f;

// ---- radii, deliberately tight ----------------------------------------------
inline constexpr float kRadiusSm = 4.0f;
inline constexpr float kRadiusMd = 6.0f;
inline constexpr float kRadiusLg = 8.0f;
/// Progress bars and pills.
inline constexpr float kRadiusFull = 999.0f;

// ---- layout -----------------------------------------------------------------
inline constexpr float kSidebarWidth = 258.0f;
inline constexpr float kTopBarHeight = 52.0f;
/// The transcript is centred and capped at a comfortable measure. Prose set to
/// the full width of a maximised window is the single loudest tell that a UI
/// was never designed to be read.
inline constexpr float kContentMaxWidth = 740.0f;

struct Fonts {
    ImFont* body = nullptr;
    // NB: not "small" — <rpcndr.h> (via windows.h) defines that as char.
    ImFont* caption = nullptr;
    ImFont* light = nullptr;   // 300 weight, for anything set large and quiet
    ImFont* medium = nullptr;  // semibold, body size: labels, buttons, titles
    ImFont* heading = nullptr; // semibold, one step up
    ImFont* display = nullptr; // the wordmark
    ImFont* mono = nullptr;
};

/// Prefers Inter and JetBrains Mono, exactly as the site asks for; falls back
/// through the same chain it declares — Segoe UI on Windows — and finally to
/// ImGui's built-in font.
Fonts loadFonts(float scale);

void applyStyle(float scale);

inline ImVec4 withAlpha(const ImVec4& color, float alpha) {
    return ImVec4(color.x, color.y, color.z, alpha);
}

inline ImVec4 mix(const ImVec4& a, const ImVec4& b, float t) {
    return ImVec4(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t,
                  a.w + (b.w - a.w) * t);
}

} // namespace dc::theme
