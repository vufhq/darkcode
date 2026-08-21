#include "theme.h"

#include <windows.h>

#include <string>

namespace dc::theme {
namespace {

std::string systemFontPath(const char* fileName) {
    char directory[MAX_PATH]{};
    const UINT length = ::GetWindowsDirectoryA(directory, MAX_PATH);
    if (length == 0) return {};
    return std::string(directory, length) + "\\Fonts\\" + fileName;
}

/// Fonts installed for the current user only live outside %WINDIR%\Fonts, which
/// is where Inter and JetBrains Mono land if someone installs them without
/// admin rights.
std::string userFontPath(const char* fileName) {
    char localAppData[MAX_PATH]{};
    const DWORD length = ::GetEnvironmentVariableA("LOCALAPPDATA", localAppData, MAX_PATH);
    if (length == 0 || length >= MAX_PATH) return {};
    return std::string(localAppData, length) + "\\Microsoft\\Windows\\Fonts\\" + fileName;
}

ImFont* tryLoad(ImGuiIO& io, const char* fileName, float sizePixels, const ImFontConfig* config) {
    for (const std::string& path : {systemFontPath(fileName), userFontPath(fileName)}) {
        if (path.empty()) continue;
        if (::GetFileAttributesA(path.c_str()) == INVALID_FILE_ATTRIBUTES) continue;
        return io.Fonts->AddFontFromFileTTF(path.c_str(), sizePixels, config);
    }
    return nullptr;
}

/// First font in the list that exists. Keeps the fallback chains readable.
ImFont* loadFirst(ImGuiIO& io, std::initializer_list<const char*> fileNames, float sizePixels,
                  const ImFontConfig* config) {
    for (const char* fileName : fileNames) {
        if (ImFont* font = tryLoad(io, fileName, sizePixels, config)) return font;
    }
    return nullptr;
}

} // namespace

void drawSpectrum(ImDrawList* draw, const ImVec2& min, const ImVec2& max, float alpha) {
    const float width = max.x - min.x;
    if (width <= 0.0f) return;

    for (int i = 0; i < kSpectrumCount - 1; ++i) {
        const float x0 = min.x + width * kSpectrumStops[i];
        const float x1 = min.x + width * kSpectrumStops[i + 1];
        if (x1 <= x0) continue;

        const ImU32 left = ImGui::GetColorU32(withAlpha(kSpectrum[i], alpha));
        const ImU32 right = ImGui::GetColorU32(withAlpha(kSpectrum[i + 1], alpha));
        // Vertical edges share a colour, so the bands meet without a seam.
        draw->AddRectFilledMultiColor(ImVec2(x0, min.y), ImVec2(x1, max.y), left, right, right, left);
    }
}

Fonts loadFonts(float scale) {
    ImGuiIO& io = ImGui::GetIO();
    Fonts fonts;

    // ImGui's default range stops at U+00FF, which would turn every em dash,
    // curly quote and ellipsis into a hollow box — and those are exactly what
    // a language model writes and what `webFetch` decodes out of a web page.
    // Must outlive the atlas build, hence static.
    static const ImWchar kRanges[] = {
        0x0020, 0x00FF, // Basic Latin + Latin-1 Supplement
        0x2010, 0x205E, // General Punctuation: dashes, quotes, ellipsis, bullet
        0x20A0, 0x20BF, // Currency symbols
        0x2190, 0x21FF, // Arrows
        0x2200, 0x22FF, // Mathematical operators
        0x2500, 0x257F, // Box drawing, for tool output
        0,
    };

    ImFontConfig config;
    config.OversampleH = 3; // small text needs the horizontal samples
    config.OversampleV = 1;
    config.PixelSnapH = true;
    config.RasterizerMultiply = 1.05f; // these faces render thin on a black ground
    config.GlyphRanges = kRanges;

    // 15px body with a 1.55 line height, as the site sets. Dense, quiet text is
    // most of what separates an application from a debug overlay.
    fonts.body = loadFirst(io, {"Inter-Regular.ttf", "Inter.ttc", "segoeui.ttf"}, 15.0f * scale, &config);
    if (!fonts.body) fonts.body = io.Fonts->AddFontDefault();

    fonts.caption = loadFirst(io, {"Inter-Regular.ttf", "Inter.ttc", "segoeui.ttf"}, 12.5f * scale, &config);
    if (!fonts.caption) fonts.caption = fonts.body;

    // Weight 300 for anything set large: the site never shouts at size.
    fonts.light = loadFirst(io, {"Inter-Light.ttf", "segoeuil.ttf", "segoeui.ttf"}, 19.0f * scale, &config);
    if (!fonts.light) fonts.light = fonts.body;

    // Semibold, not bold: bold at these sizes reads as shouting.
    fonts.medium = loadFirst(io, {"Inter-SemiBold.ttf", "seguisb.ttf", "segoeuib.ttf"}, 13.0f * scale, &config);
    if (!fonts.medium) fonts.medium = fonts.body;

    fonts.heading = loadFirst(io, {"Inter-SemiBold.ttf", "seguisb.ttf", "segoeuib.ttf"}, 15.0f * scale, &config);
    if (!fonts.heading) fonts.heading = fonts.body;

    fonts.display = loadFirst(io, {"Inter-SemiBold.ttf", "seguisb.ttf", "segoeuib.ttf"}, 16.5f * scale, &config);
    if (!fonts.display) fonts.display = fonts.heading;

    fonts.mono = loadFirst(io, {"JetBrainsMono-Regular.ttf", "CascadiaMono.ttf", "consola.ttf"},
                           12.0f * scale, &config);
    if (!fonts.mono) fonts.mono = fonts.body;

    io.FontDefault = fonts.body;
    return fonts;
}

void applyStyle(float scale) {
    ImGuiStyle& style = ImGui::GetStyle();
    style = ImGuiStyle();

    style.WindowPadding = ImVec2(kSpace4, kSpace4);
    style.FramePadding = ImVec2(kSpace3, kSpace2);
    style.CellPadding = ImVec2(kSpace2, kSpace1 + 2.0f);
    style.ItemSpacing = ImVec2(kSpace2, kSpace2);
    style.ItemInnerSpacing = ImVec2(kSpace2, kSpace1 + 2.0f);
    style.ScrollbarSize = 10.0f;
    style.GrabMinSize = 8.0f;

    style.WindowBorderSize = 0.0f;
    style.ChildBorderSize = 1.0f;
    style.PopupBorderSize = 1.0f;
    style.FrameBorderSize = 1.0f;

    style.WindowRounding = 0.0f;
    style.ChildRounding = kRadiusMd;
    style.FrameRounding = kRadiusMd;
    style.PopupRounding = kRadiusLg;
    style.ScrollbarRounding = kRadiusFull;
    style.GrabRounding = kRadiusFull;
    style.TabRounding = kRadiusMd;

    style.WindowTitleAlign = ImVec2(0.0f, 0.5f);
    style.SeparatorTextBorderSize = 1.0f;
    style.SeparatorTextPadding = ImVec2(kSpace3, kSpace2);
    style.SeparatorTextAlign = ImVec2(0.0f, 0.5f);

    ImVec4* colors = style.Colors;
    colors[ImGuiCol_WindowBg] = kCanvas;
    colors[ImGuiCol_ChildBg] = ImVec4(0, 0, 0, 0);
    colors[ImGuiCol_PopupBg] = ImVec4(0.043f, 0.043f, 0.043f, 1.0f); // opaque, or the page shows through
    colors[ImGuiCol_Border] = kBorder;
    colors[ImGuiCol_BorderShadow] = ImVec4(0, 0, 0, 0);

    colors[ImGuiCol_Text] = kText;
    colors[ImGuiCol_TextDisabled] = kTextFaint;
    colors[ImGuiCol_TextSelectedBg] = ImVec4(1.0f, 1.0f, 1.0f, 0.16f);

    colors[ImGuiCol_FrameBg] = kSurface;
    colors[ImGuiCol_FrameBgHovered] = kSurfaceHover;
    colors[ImGuiCol_FrameBgActive] = kSurfaceActive;

    colors[ImGuiCol_TitleBg] = kCanvas;
    colors[ImGuiCol_TitleBgActive] = kCanvas;
    colors[ImGuiCol_TitleBgCollapsed] = kCanvas;

    // Every secondary control is the ground plus a little white. The one
    // primary action per screen inverts to white-on-black at the call site.
    colors[ImGuiCol_Button] = kSurface;
    colors[ImGuiCol_ButtonHovered] = kSurfaceHover;
    colors[ImGuiCol_ButtonActive] = kSurfaceActive;

    colors[ImGuiCol_Header] = kSurfaceHover;
    colors[ImGuiCol_HeaderHovered] = kSurfaceHover;
    colors[ImGuiCol_HeaderActive] = kSurfaceActive;

    colors[ImGuiCol_Separator] = kBorder;
    colors[ImGuiCol_SeparatorHovered] = kBorderStrong;
    colors[ImGuiCol_SeparatorActive] = kBorderStrong;

    colors[ImGuiCol_ScrollbarBg] = ImVec4(0, 0, 0, 0);
    colors[ImGuiCol_ScrollbarGrab] = ImVec4(1.0f, 1.0f, 1.0f, 0.12f);
    colors[ImGuiCol_ScrollbarGrabHovered] = ImVec4(1.0f, 1.0f, 1.0f, 0.20f);
    colors[ImGuiCol_ScrollbarGrabActive] = ImVec4(1.0f, 1.0f, 1.0f, 0.28f);

    colors[ImGuiCol_CheckMark] = kText;
    colors[ImGuiCol_SliderGrab] = kText;
    colors[ImGuiCol_SliderGrabActive] = kAccentHover;

    colors[ImGuiCol_Tab] = kSurface;
    colors[ImGuiCol_TabHovered] = kSurfaceHover;
    colors[ImGuiCol_TabSelected] = kSurfaceActive;

    colors[ImGuiCol_ModalWindowDimBg] = ImVec4(0.0f, 0.0f, 0.0f, 0.72f);
    colors[ImGuiCol_NavCursor] = kFocusRing;

    style.ScaleAllSizes(scale);
}

} // namespace dc::theme
