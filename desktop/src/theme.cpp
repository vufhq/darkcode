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

ImFont* tryLoad(ImGuiIO& io, const char* fileName, float sizePixels, const ImFontConfig* config) {
    const std::string path = systemFontPath(fileName);
    if (path.empty()) return nullptr;
    if (::GetFileAttributesA(path.c_str()) == INVALID_FILE_ATTRIBUTES) return nullptr;
    return io.Fonts->AddFontFromFileTTF(path.c_str(), sizePixels, config);
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
    config.RasterizerMultiply = 1.05f; // Segoe UI renders thin on a dark ground
    config.GlyphRanges = kRanges;

    // Deliberately smaller than the usual ImGui defaults. Dense, quiet text is
    // most of what separates an application from a debug overlay.
    fonts.body = loadFirst(io, {"segoeui.ttf"}, 15.0f * scale, &config);
    if (!fonts.body) fonts.body = io.Fonts->AddFontDefault();

    fonts.caption = loadFirst(io, {"segoeui.ttf"}, 12.5f * scale, &config);
    if (!fonts.caption) fonts.caption = fonts.body;

    // Semibold, not bold: bold at these sizes reads as shouting.
    fonts.medium = loadFirst(io, {"seguisb.ttf", "segoeuib.ttf"}, 13.5f * scale, &config);
    if (!fonts.medium) fonts.medium = fonts.body;

    fonts.heading = loadFirst(io, {"seguisb.ttf", "segoeuib.ttf"}, 15.5f * scale, &config);
    if (!fonts.heading) fonts.heading = fonts.body;

    fonts.display = loadFirst(io, {"seguisb.ttf", "segoeuib.ttf"}, 17.0f * scale, &config);
    if (!fonts.display) fonts.display = fonts.heading;

    fonts.mono = loadFirst(io, {"CascadiaMono.ttf", "consola.ttf"}, 12.5f * scale, &config);
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
    style.ChildRounding = kRadiusLg;
    style.FrameRounding = kRadiusMd;
    style.PopupRounding = kRadiusLg;
    style.ScrollbarRounding = 8.0f;
    style.GrabRounding = 8.0f;
    style.TabRounding = kRadiusMd;

    style.WindowTitleAlign = ImVec2(0.0f, 0.5f);
    style.SeparatorTextBorderSize = 1.0f;
    style.SeparatorTextPadding = ImVec2(kSpace3, kSpace2);
    style.SeparatorTextAlign = ImVec2(0.0f, 0.5f);

    ImVec4* colors = style.Colors;
    colors[ImGuiCol_WindowBg] = kCanvas;
    colors[ImGuiCol_ChildBg] = ImVec4(0, 0, 0, 0);
    colors[ImGuiCol_PopupBg] = kSurface;
    colors[ImGuiCol_Border] = kBorder;
    colors[ImGuiCol_BorderShadow] = ImVec4(0, 0, 0, 0);

    colors[ImGuiCol_Text] = kText;
    colors[ImGuiCol_TextDisabled] = kTextFaint;
    colors[ImGuiCol_TextSelectedBg] = withAlpha(kAccent, 0.30f);

    colors[ImGuiCol_FrameBg] = kSurface;
    colors[ImGuiCol_FrameBgHovered] = kSurfaceHover;
    colors[ImGuiCol_FrameBgActive] = kSurfaceActive;

    colors[ImGuiCol_TitleBg] = kSidebar;
    colors[ImGuiCol_TitleBgActive] = kSidebar;
    colors[ImGuiCol_TitleBgCollapsed] = kSidebar;

    // Secondary buttons are surfaces, not coloured slabs. The one primary
    // action per screen gets the accent, applied at the call site.
    colors[ImGuiCol_Button] = kSurface;
    colors[ImGuiCol_ButtonHovered] = kSurfaceHover;
    colors[ImGuiCol_ButtonActive] = kSurfaceActive;

    colors[ImGuiCol_Header] = withAlpha(kAccent, 0.16f);
    colors[ImGuiCol_HeaderHovered] = kSurfaceHover;
    colors[ImGuiCol_HeaderActive] = withAlpha(kAccent, 0.24f);

    colors[ImGuiCol_Separator] = kBorder;
    colors[ImGuiCol_SeparatorHovered] = kBorderStrong;
    colors[ImGuiCol_SeparatorActive] = kAccent;

    colors[ImGuiCol_ScrollbarBg] = ImVec4(0, 0, 0, 0);
    colors[ImGuiCol_ScrollbarGrab] = withAlpha(kTextFaint, 0.30f);
    colors[ImGuiCol_ScrollbarGrabHovered] = withAlpha(kTextFaint, 0.50f);
    colors[ImGuiCol_ScrollbarGrabActive] = withAlpha(kTextMuted, 0.70f);

    colors[ImGuiCol_CheckMark] = kAccent;
    colors[ImGuiCol_SliderGrab] = kAccent;
    colors[ImGuiCol_SliderGrabActive] = kAccentHover;

    colors[ImGuiCol_Tab] = kSurface;
    colors[ImGuiCol_TabHovered] = kSurfaceHover;
    colors[ImGuiCol_TabSelected] = kSurfaceActive;

    colors[ImGuiCol_ModalWindowDimBg] = ImVec4(0.02f, 0.02f, 0.03f, 0.72f);
    colors[ImGuiCol_NavCursor] = withAlpha(kAccent, 0.70f);

    style.ScaleAllSizes(scale);
}

} // namespace dc::theme
