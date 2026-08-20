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

ImFont* tryLoad(ImGuiIO& io, const char* fileName, float sizePixels, const ImFontConfig* config = nullptr) {
    const std::string path = systemFontPath(fileName);
    if (path.empty()) return nullptr;
    if (::GetFileAttributesA(path.c_str()) == INVALID_FILE_ATTRIBUTES) return nullptr;
    return io.Fonts->AddFontFromFileTTF(path.c_str(), sizePixels, config);
}

} // namespace

Fonts loadFonts(float scale) {
    ImGuiIO& io = ImGui::GetIO();
    Fonts fonts;

    ImFontConfig config;
    config.OversampleH = 2;
    config.OversampleV = 1;
    config.PixelSnapH = true;

    fonts.body = tryLoad(io, "segoeui.ttf", 17.0f * scale, &config);
    if (!fonts.body) fonts.body = io.Fonts->AddFontDefault();

    fonts.caption = tryLoad(io, "segoeui.ttf", 14.0f * scale, &config);
    if (!fonts.caption) fonts.caption = fonts.body;

    fonts.heading = tryLoad(io, "segoeuib.ttf", 19.0f * scale, &config);
    if (!fonts.heading) fonts.heading = fonts.body;

    fonts.mono = tryLoad(io, "consola.ttf", 15.0f * scale, &config);
    if (!fonts.mono) fonts.mono = fonts.body;

    io.FontDefault = fonts.body;
    return fonts;
}

void applyStyle(float scale) {
    ImGuiStyle& style = ImGui::GetStyle();
    style = ImGuiStyle();

    style.WindowPadding = ImVec2(16, 16);
    style.FramePadding = ImVec2(12, 8);
    style.CellPadding = ImVec2(8, 6);
    style.ItemSpacing = ImVec2(10, 8);
    style.ItemInnerSpacing = ImVec2(8, 6);
    style.ScrollbarSize = 12.0f;
    style.GrabMinSize = 10.0f;

    style.WindowBorderSize = 0.0f;
    style.ChildBorderSize = 1.0f;
    style.PopupBorderSize = 1.0f;
    style.FrameBorderSize = 1.0f;

    style.WindowRounding = 0.0f;
    style.ChildRounding = 10.0f;
    style.FrameRounding = 8.0f;
    style.PopupRounding = 10.0f;
    style.ScrollbarRounding = 8.0f;
    style.GrabRounding = 8.0f;
    style.TabRounding = 8.0f;

    style.WindowTitleAlign = ImVec2(0.0f, 0.5f);
    style.SeparatorTextBorderSize = 1.0f;
    style.SeparatorTextPadding = ImVec2(16, 6);

    ImVec4* colors = style.Colors;
    colors[ImGuiCol_WindowBg] = kBackground;
    colors[ImGuiCol_ChildBg] = kPanel;
    colors[ImGuiCol_PopupBg] = kPanelRaised;
    colors[ImGuiCol_Border] = kBorder;
    colors[ImGuiCol_BorderShadow] = ImVec4(0, 0, 0, 0);

    colors[ImGuiCol_Text] = kText;
    colors[ImGuiCol_TextDisabled] = kTextFaint;
    colors[ImGuiCol_TextSelectedBg] = withAlpha(kAccent, 0.35f);

    colors[ImGuiCol_FrameBg] = kPanelRaised;
    colors[ImGuiCol_FrameBgHovered] = ImVec4(0.137f, 0.149f, 0.180f, 1.0f);
    colors[ImGuiCol_FrameBgActive] = ImVec4(0.161f, 0.176f, 0.212f, 1.0f);

    colors[ImGuiCol_TitleBg] = kPanel;
    colors[ImGuiCol_TitleBgActive] = kPanel;
    colors[ImGuiCol_TitleBgCollapsed] = kPanel;

    colors[ImGuiCol_Button] = kPanelRaised;
    colors[ImGuiCol_ButtonHovered] = ImVec4(0.180f, 0.192f, 0.231f, 1.0f);
    colors[ImGuiCol_ButtonActive] = withAlpha(kAccent, 0.45f);

    colors[ImGuiCol_Header] = withAlpha(kAccent, 0.20f);
    colors[ImGuiCol_HeaderHovered] = withAlpha(kAccent, 0.30f);
    colors[ImGuiCol_HeaderActive] = withAlpha(kAccent, 0.42f);

    colors[ImGuiCol_Separator] = kBorder;
    colors[ImGuiCol_SeparatorHovered] = withAlpha(kAccent, 0.55f);
    colors[ImGuiCol_SeparatorActive] = kAccent;

    colors[ImGuiCol_ScrollbarBg] = ImVec4(0, 0, 0, 0);
    colors[ImGuiCol_ScrollbarGrab] = ImVec4(0.220f, 0.235f, 0.278f, 1.0f);
    colors[ImGuiCol_ScrollbarGrabHovered] = ImVec4(0.290f, 0.310f, 0.365f, 1.0f);
    colors[ImGuiCol_ScrollbarGrabActive] = withAlpha(kAccent, 0.75f);

    colors[ImGuiCol_CheckMark] = kAccent;
    colors[ImGuiCol_SliderGrab] = kAccent;
    colors[ImGuiCol_SliderGrabActive] = kAccent;

    colors[ImGuiCol_Tab] = kPanel;
    colors[ImGuiCol_TabHovered] = withAlpha(kAccent, 0.35f);
    colors[ImGuiCol_TabSelected] = kPanelRaised;

    colors[ImGuiCol_ModalWindowDimBg] = ImVec4(0.02f, 0.02f, 0.03f, 0.65f);
    colors[ImGuiCol_NavCursor] = withAlpha(kAccent, 0.7f);

    style.ScaleAllSizes(scale);
}

} // namespace dc::theme
