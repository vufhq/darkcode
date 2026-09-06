// Per-widget easing for an immediate-mode UI.
//
// ImGui redraws from scratch every frame and keeps no widget state, so a hover
// fade needs somewhere to remember where it got to. `toward()` keeps one float
// per ImGui id and eases it toward a target using a frame-rate independent
// exponential curve — the ease-out family, no bounce, no elastic.
//
// Motion here conveys state and nothing else: hover, selection, focus, work in
// progress. There is deliberately no entrance choreography; the app opens into
// a task and nobody wants to watch it load.
#pragma once

#include "imgui.h"
#include "theme.h"
#include "window.h"

#include <cmath>
#include <unordered_map>

namespace dc::anim {

/// Typical durations, in seconds. Product motion sits at the short end: the
/// user is in flow and should never wait on choreography.
inline constexpr float kFast = 0.12f;
inline constexpr float kBase = 0.16f;
inline constexpr float kSlow = 0.22f;

/// Eases the value stored under `id` toward `target` (usually 0 or 1) and
/// returns the current position.
///
/// The step is `1 - exp(-dt / tau)`, which reaches the same place after the
/// same wall-clock time whatever the frame rate — a plain `lerp(a, b, 0.1f)`
/// would ease twice as fast at 120Hz as at 60Hz.
inline float toward(ImGuiID id, float target, float seconds = kBase) {
    static std::unordered_map<ImGuiID, float> values;

    // Windows' answer to prefers-reduced-motion. When the user has turned
    // system animation off, every transition collapses to a state change.
    if (!window::animationsEnabled() || seconds <= 0.0f) {
        values[id] = target;
        return target;
    }

    float& value = values.try_emplace(id, target).first->second;
    const float dt = ImGui::GetIO().DeltaTime;
    if (dt > 0.0f) {
        const float tau = seconds * 0.35f; // seconds ≈ time to settle visually
        value += (target - value) * (1.0f - std::exp(-dt / tau));
        if (std::fabs(target - value) < 0.001f) value = target;
    }
    return value;
}

/// Convenience for the common "fade this colour in on hover" case.
inline ImVec4 fade(const ImVec4& color, float amount) {
    return theme::withAlpha(color, color.w * amount);
}

/// Mixes two colours by an eased amount.
inline ImVec4 blend(const ImVec4& from, const ImVec4& to, float amount) {
    return theme::mix(from, to, amount);
}

} // namespace dc::anim
