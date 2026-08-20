// The app's visual system: one palette, one spacing scale, one type ramp, and
// the ImGui style that follows from them.
//
// Two rules hold the look together. Surfaces are separated by *value* and a
// hairline border rather than by heavy fills, so the window reads as one
// object rather than a stack of boxes. And the accent is spent sparingly —
// primary action, selection, focus — because a colour used everywhere stops
// meaning anything.
#pragma once

#include "imgui.h"

namespace dc::theme {

// ---- surfaces (dark to light) ----------------------------------------------
inline const ImVec4 kCanvas{0.043f, 0.047f, 0.055f, 1.0f};       // #0B0C0E
inline const ImVec4 kSidebar{0.055f, 0.059f, 0.071f, 1.0f};      // #0E0F12
inline const ImVec4 kSurface{0.075f, 0.082f, 0.098f, 1.0f};      // #131519
inline const ImVec4 kSurfaceHover{0.094f, 0.106f, 0.125f, 1.0f}; // #181B20
inline const ImVec4 kSurfaceActive{0.118f, 0.129f, 0.153f, 1.0f};

// ---- lines ------------------------------------------------------------------
inline const ImVec4 kBorder{0.122f, 0.133f, 0.157f, 1.0f};       // hairline
inline const ImVec4 kBorderStrong{0.165f, 0.180f, 0.212f, 1.0f};

// ---- text -------------------------------------------------------------------
inline const ImVec4 kText{0.929f, 0.933f, 0.941f, 1.0f};         // #EDEEF0
inline const ImVec4 kTextMuted{0.608f, 0.631f, 0.675f, 1.0f};    // #9BA1AC
inline const ImVec4 kTextFaint{0.420f, 0.447f, 0.502f, 1.0f};    // #6B7280

// ---- accents ----------------------------------------------------------------
inline const ImVec4 kAccent{0.482f, 0.424f, 0.965f, 1.0f};       // #7B6CF6
inline const ImVec4 kAccentHover{0.545f, 0.494f, 1.0f, 1.0f};
inline const ImVec4 kSuccess{0.290f, 0.741f, 0.451f, 1.0f};
inline const ImVec4 kWarning{0.902f, 0.678f, 0.294f, 1.0f};
inline const ImVec4 kDanger{0.937f, 0.400f, 0.400f, 1.0f};

// ---- spacing, on a 4pt grid -------------------------------------------------
inline constexpr float kSpace1 = 4.0f;
inline constexpr float kSpace2 = 8.0f;
inline constexpr float kSpace3 = 12.0f;
inline constexpr float kSpace4 = 16.0f;
inline constexpr float kSpace5 = 24.0f;
inline constexpr float kSpace6 = 32.0f;

// ---- radii ------------------------------------------------------------------
inline constexpr float kRadiusSm = 5.0f;
inline constexpr float kRadiusMd = 7.0f;
inline constexpr float kRadiusLg = 10.0f;

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
    ImFont* medium = nullptr;  // semibold, body size: labels, buttons, titles
    ImFont* heading = nullptr; // semibold, one step up
    ImFont* display = nullptr; // the wordmark
    ImFont* mono = nullptr;
};

/// Segoe UI / Segoe UI Semibold / Cascadia Mono, each falling back to the next
/// best thing and finally to ImGui's built-in font.
Fonts loadFonts(float scale);

void applyStyle(float scale);

inline ImVec4 withAlpha(const ImVec4& color, float alpha) {
    return ImVec4(color.x, color.y, color.z, alpha);
}

/// Mixes toward `b`. Used for hover/pressed states so they stay in the ramp
/// instead of being hand-picked one-offs.
inline ImVec4 mix(const ImVec4& a, const ImVec4& b, float t) {
    return ImVec4(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t,
                  a.w + (b.w - a.w) * t);
}

} // namespace dc::theme
