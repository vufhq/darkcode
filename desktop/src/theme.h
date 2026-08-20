// Visual language for the app: one dark palette, one type scale, and the
// ImGui style that follows from them.
#pragma once

#include "imgui.h"

namespace dc::theme {

// Surfaces
inline const ImVec4 kBackground{0.055f, 0.059f, 0.075f, 1.0f};
inline const ImVec4 kPanel{0.078f, 0.086f, 0.106f, 1.0f};
inline const ImVec4 kPanelRaised{0.106f, 0.116f, 0.141f, 1.0f};
inline const ImVec4 kBorder{0.157f, 0.169f, 0.204f, 1.0f};

// Text
inline const ImVec4 kText{0.902f, 0.910f, 0.925f, 1.0f};
inline const ImVec4 kTextMuted{0.549f, 0.580f, 0.631f, 1.0f};
inline const ImVec4 kTextFaint{0.400f, 0.427f, 0.478f, 1.0f};

// Accents
inline const ImVec4 kAccent{0.486f, 0.361f, 1.0f, 1.0f};
inline const ImVec4 kAccentDim{0.486f, 0.361f, 1.0f, 0.18f};
inline const ImVec4 kSuccess{0.247f, 0.725f, 0.314f, 1.0f};
inline const ImVec4 kWarning{0.824f, 0.600f, 0.133f, 1.0f};
inline const ImVec4 kDanger{0.973f, 0.318f, 0.286f, 1.0f};

struct Fonts {
    ImFont* body = nullptr;
    // NB: not "small" — <rpcndr.h> (via windows.h) defines that as char.
    ImFont* caption = nullptr;
    ImFont* heading = nullptr;
    ImFont* mono = nullptr;
};

/// Loads Segoe UI / Consolas from the system font directory, falling back to
/// ImGui's built-in font when either is missing.
Fonts loadFonts(float scale);

void applyStyle(float scale);

inline ImVec4 withAlpha(const ImVec4& color, float alpha) {
    return ImVec4(color.x, color.y, color.z, alpha);
}

} // namespace dc::theme
