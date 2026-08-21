// All rendering.
//
// The layout is hand-laid rather than docked: a fixed sidebar, a top bar
// carrying the session's controls, a transcript that takes the remaining
// height, then the composer and a status line. Predictable, and it keeps the
// window free of chrome the user has to arrange before the app is usable.
//
// Two conventions run through this file. Panels are separated by value and a
// hairline rather than by borders on everything, and the transcript is capped
// at a readable measure and centred instead of stretching to the window width.
#include "app.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

#include "imgui.h"
#include "models.h"
#include "util.h"

namespace dc {
namespace {

using namespace theme;

// ---------------------------------------------------------------------------
// Small RAII wrappers. ImGui's push/pop pairs are easy to leak past an early
// return; scoping them makes that impossible.
// ---------------------------------------------------------------------------

class FontScope {
public:
    explicit FontScope(ImFont* font) : pushed_(font != nullptr) {
        if (pushed_) ImGui::PushFont(font);
    }
    ~FontScope() {
        if (pushed_) ImGui::PopFont();
    }
    FontScope(const FontScope&) = delete;
    FontScope& operator=(const FontScope&) = delete;

private:
    bool pushed_;
};

class ColorScope {
public:
    ColorScope(ImGuiCol index, const ImVec4& color) : count_(1) { ImGui::PushStyleColor(index, color); }
    ColorScope(ImGuiCol a, const ImVec4& ca, ImGuiCol b, const ImVec4& cb) : count_(2) {
        ImGui::PushStyleColor(a, ca);
        ImGui::PushStyleColor(b, cb);
    }
    ColorScope(ImGuiCol a, const ImVec4& ca, ImGuiCol b, const ImVec4& cb, ImGuiCol c, const ImVec4& cc)
        : count_(3) {
        ImGui::PushStyleColor(a, ca);
        ImGui::PushStyleColor(b, cb);
        ImGui::PushStyleColor(c, cc);
    }
    ~ColorScope() { ImGui::PopStyleColor(count_); }
    ColorScope(const ColorScope&) = delete;
    ColorScope& operator=(const ColorScope&) = delete;

private:
    int count_;
};

// ---------------------------------------------------------------------------
// Text primitives
// ---------------------------------------------------------------------------

void text(const std::string& value, const ImVec4& color) {
    const ColorScope scope(ImGuiCol_Text, color);
    ImGui::TextUnformatted(value.c_str());
}

void wrapped(const std::string& value, const ImVec4& color) {
    const ColorScope scope(ImGuiCol_Text, color);
    ImGui::TextWrapped("%s", value.c_str());
}

void space(float pixels) { ImGui::Dummy(ImVec2(0.0f, pixels)); }

/// Trims to fit, appending an ellipsis. Abrupt clipping mid-glyph is one of
/// those details that reads as unfinished even when nobody can say why.
std::string elide(const std::string& value, float maxWidth) {
    if (maxWidth <= 0.0f) return {};
    if (ImGui::CalcTextSize(value.c_str()).x <= maxWidth) return value;

    std::string out = value;
    while (!out.empty()) {
        // Never split a UTF-8 sequence: drop continuation bytes with the lead.
        out.pop_back();
        while (!out.empty() && (static_cast<unsigned char>(out.back()) & 0xC0) == 0x80) out.pop_back();
        if (ImGui::CalcTextSize((out + "\xE2\x80\xA6").c_str()).x <= maxWidth) break;
    }
    return out + "\xE2\x80\xA6"; // U+2026
}

/// A one-pixel rule at the current cursor, spanning the available width.
void hairline(float inset = 0.0f) {
    const ImVec2 origin = ImGui::GetCursorScreenPos();
    const float width = ImGui::GetContentRegionAvail().x;
    ImGui::GetWindowDrawList()->AddLine(ImVec2(origin.x + inset, origin.y),
                                        ImVec2(origin.x + width - inset, origin.y),
                                        ImGui::GetColorU32(kBorder));
    ImGui::Dummy(ImVec2(0.0f, 1.0f));
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/// Primary is the inversion, not a colour: white ground, black label.
bool primaryButton(const char* label, const ImVec2& size = ImVec2(0, 0)) {
    const ColorScope colors(ImGuiCol_Button, kAccent, ImGuiCol_ButtonHovered, kAccentHover,
                            ImGuiCol_ButtonActive, mix(kAccent, kCanvas, 0.12f));
    const ColorScope textColor(ImGuiCol_Text, kOnAccent);
    ImGui::PushStyleColor(ImGuiCol_Border, ImVec4(0, 0, 0, 0));
    const bool pressed = ImGui::Button(label, size);
    ImGui::PopStyleColor();
    return pressed;
}

bool secondaryButton(const char* label, const ImVec2& size = ImVec2(0, 0)) {
    return ImGui::Button(label, size);
}

/// No fill until hovered. For tertiary actions that should not compete.
bool ghostButton(const char* label, const ImVec2& size = ImVec2(0, 0)) {
    const ColorScope colors(ImGuiCol_Button, ImVec4(0, 0, 0, 0), ImGuiCol_ButtonHovered, kSurfaceHover,
                            ImGuiCol_Text, kTextMuted);
    ImGui::PushStyleColor(ImGuiCol_Border, ImVec4(0, 0, 0, 0));
    const bool pressed = ImGui::Button(label, size);
    ImGui::PopStyleColor();
    return pressed;
}

bool dangerButton(const char* label, const ImVec2& size = ImVec2(0, 0)) {
    const ColorScope colors(ImGuiCol_Button, withAlpha(kDanger, 0.16f), ImGuiCol_ButtonHovered,
                            withAlpha(kDanger, 0.26f), ImGuiCol_Text, kDanger);
    ImGui::PushStyleColor(ImGuiCol_Border, withAlpha(kDanger, 0.45f));
    const bool pressed = ImGui::Button(label, size);
    ImGui::PopStyleColor();
    return pressed;
}

/// ImGui derives the checkbox square from FramePadding, which is tuned for
/// text inputs and leaves the box towering over its own label. Compact it.
bool compactCheckbox(const char* label, bool* value) {
    ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(kSpace1, 3.0f));
    const bool changed = ImGui::Checkbox(label, value);
    ImGui::PopStyleVar();
    return changed;
}

/// A small filled dot. Tool status, connection state.
void statusDot(const ImVec4& color, float sizeScale = 0.22f) {
    const float radius = ImGui::GetFontSize() * sizeScale;
    const ImVec2 cursor = ImGui::GetCursorScreenPos();
    const ImVec2 center(cursor.x + radius, cursor.y + ImGui::GetTextLineHeight() * 0.5f);
    ImGui::GetWindowDrawList()->AddCircleFilled(center, radius, ImGui::GetColorU32(color));
    ImGui::Dummy(ImVec2(radius * 2.0f, ImGui::GetTextLineHeight()));
    ImGui::SameLine(0.0f, kSpace2);
}

// ---------------------------------------------------------------------------
// Tool summaries
// ---------------------------------------------------------------------------

/// One-line description of what a tool call is doing, from its input.
std::string toolSummary(const ToolCall& tool) {
    const json& input = tool.input;
    const auto str = [&](const char* key) -> std::string {
        return input.is_object() && input.contains(key) && input[key].is_string()
                   ? input[key].get<std::string>()
                   : std::string();
    };

    if (tool.toolName == "bash") return str("command");
    if (tool.toolName == "webFetch") return str("url");
    if (tool.toolName == "grep") {
        const std::string where = str("path");
        return str("pattern") + (where.empty() || where == "." ? "" : "  in " + where);
    }
    if (tool.toolName == "glob") return str("pattern");
    if (tool.toolName == "todoWrite") {
        if (input.is_object() && input.contains("todos") && input["todos"].is_array()) {
            return std::to_string(input["todos"].size()) + " tasks";
        }
        return "task list";
    }
    const std::string path = str("path");
    if (!path.empty()) return path;
    return input.is_object() && !input.empty() ? input.dump() : std::string();
}

std::string formatDuration(long long ms) {
    char buffer[32];
    if (ms < 1000) std::snprintf(buffer, sizeof(buffer), "%lldms", ms);
    else std::snprintf(buffer, sizeof(buffer), "%.1fs", static_cast<double>(ms) / 1000.0);
    return buffer;
}

/// Compact rendering of a tool result. The raw JSON is available on expand;
/// this is the line the user actually reads.
std::string toolResultPreview(const ToolCall& tool) {
    if (tool.state == ToolState::OutputError) return tool.errorText;
    if (!tool.output.is_object()) return tool.output.is_null() ? "" : tool.output.dump();

    const json& output = tool.output;
    if (tool.toolName == "readFile") {
        return std::to_string(output.value("endLine", 0) - output.value("startLine", 0) + 1) +
               " lines of " + std::to_string(output.value("totalLines", 0));
    }
    if (tool.toolName == "listDirectory" && output.contains("entries")) {
        return std::to_string(output["entries"].size()) + " entries";
    }
    if (tool.toolName == "glob" && output.contains("files")) {
        return std::to_string(output["files"].size()) + " files";
    }
    if (tool.toolName == "grep" && output.contains("matches")) {
        return std::to_string(output["matches"].size()) + " matches";
    }
    if (tool.toolName == "bash") {
        const int exitCode = output.value("exitCode", 0);
        const std::string out = trim(output.value("stdout", std::string()));
        const std::string err = trim(output.value("stderr", std::string()));
        std::string summary = "exit " + std::to_string(exitCode);
        const std::string body = !out.empty() ? out : err;
        if (!body.empty()) summary += "   " + splitLines(body).front();
        return summary;
    }
    if (tool.toolName == "webFetch") {
        const std::string title = output.value("title", std::string());
        std::string summary = std::to_string(output.value("status", 0)) + " " +
                              output.value("format", std::string()) + ", " +
                              humanBytes(static_cast<long long>(output.value("content", std::string()).size()));
        if (!title.empty()) summary += "   " + title;
        return summary;
    }
    if (output.contains("bytesWritten")) {
        return humanBytes(output.value("bytesWritten", 0LL)) + " written";
    }
    if (output.value("success", false)) return "done";
    return output.dump();
}

ImVec4 toolStateColor(ToolState state) {
    switch (state) {
        case ToolState::OutputAvailable: return kSuccess;
        case ToolState::OutputError: return kDanger;
        case ToolState::InputAvailable: return kWarning;
        case ToolState::InputStreaming: return kTextFaint;
    }
    return kTextFaint;
}

/// The site's indeterminate track: a 2px rule with a spectrum segment sweeping
/// across it. This is the one place besides the mark where colour appears, and
/// it makes a long pause read as "working" rather than "hung".
void workingTrack(float width) {
    constexpr float kHeight = 2.0f;
    constexpr float kPeriod = 2.2f;   // matches the site's np-sweep
    constexpr float kSegment = 0.38f; // fraction of the track that travels

    const ImVec2 origin = ImGui::GetCursorScreenPos();
    ImDrawList* draw = ImGui::GetWindowDrawList();

    const ImVec2 trackMax(origin.x + width, origin.y + kHeight);
    draw->AddRectFilled(origin, trackMax, ImGui::GetColorU32(ImVec4(1, 1, 1, 0.12f)), kRadiusFull);

    const float segment = width * kSegment;
    const float phase = static_cast<float>(std::fmod(ImGui::GetTime(), kPeriod)) / kPeriod;
    // translate(-100%) → translate(266%) of the segment's own width
    const float x = origin.x + (-1.0f + phase * 3.66f) * segment;

    draw->PushClipRect(origin, trackMax, true);
    drawSpectrum(draw, ImVec2(x, origin.y), ImVec2(x + segment, trackMax.y));
    draw->PopClipRect();

    ImGui::Dummy(ImVec2(width, kHeight));
}

const char* const kSuggestions[] = {
    "Explain the architecture of this project",
    "Find every TODO and summarise what is left",
    "Add a test for the trickiest function here",
};

} // namespace

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

void App::render() {
    const ImGuiViewport* viewport = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(viewport->WorkPos);
    ImGui::SetNextWindowSize(viewport->WorkSize);

    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0, 0));
    const ColorScope background(ImGuiCol_WindowBg, kCanvas);
    ImGui::Begin("##root", nullptr,
                 ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove |
                     ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoScrollbar |
                     ImGuiWindowFlags_NoScrollWithMouse | ImGuiWindowFlags_NoBringToFrontOnFocus |
                     ImGuiWindowFlags_NoNavFocus);
    ImGui::PopStyleVar();

    drawSidebar(kSidebarWidth);
    ImGui::SameLine(0.0f, 0.0f);

    // The seam between sidebar and content: one hairline, full height.
    const ImVec2 seam = ImGui::GetCursorScreenPos();
    ImGui::GetWindowDrawList()->AddLine(seam, ImVec2(seam.x, seam.y + viewport->WorkSize.y),
                                        ImGui::GetColorU32(kBorder));

    drawMainColumn();
    ImGui::End();

    drawPermissionModal();
    if (showSettings_) drawSettingsWindow();
    drawToast();
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

void App::drawSidebar(float width) {
    const ColorScope background(ImGuiCol_ChildBg, kSidebar);
    ImGui::BeginChild("##sidebar", ImVec2(width, 0), ImGuiChildFlags_None,
                      ImGuiWindowFlags_NoScrollbar);

    bool streaming = false;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        streaming = streaming_;
    }

    // ---- wordmark --------------------------------------------------------
    // The word, then a short spectrum rule beneath it. No logo tile: the site
    // has no mark either, and the only colour it spends is on a 2px bar.
    ImGui::SetCursorPos(ImVec2(kSpace4, kSpace4));
    {
        const FontScope font(fonts_.display);
        text("DarkCode", kText);
    }
    {
        const ImVec2 origin = ImGui::GetCursorScreenPos();
        drawSpectrum(ImGui::GetWindowDrawList(), ImVec2(origin.x + kSpace4, origin.y + kSpace1),
                     ImVec2(origin.x + kSpace4 + 30.0f, origin.y + kSpace1 + 2.0f));
    }

    ImGui::SetCursorPosX(kSpace4);
    space(kSpace3);

    // ---- new session -----------------------------------------------------
    ImGui::SetCursorPosX(kSpace4);
    ImGui::BeginDisabled(streaming);
    // Secondary, not inverted: there is exactly one white element on screen and
    // it is Send. Two of them would compete, and the language spends contrast
    // as sparingly as it spends colour.
    if (secondaryButton("New session", ImVec2(width - kSpace4 * 2.0f, 34.0f))) startNewSession();
    ImGui::EndDisabled();

    space(kSpace4);
    ImGui::SetCursorPosX(kSpace4);
    {
        const FontScope font(fonts_.caption);
        text("SESSIONS", kTextFaint);
    }
    space(kSpace1);

    // ---- session list ----------------------------------------------------
    // Anchored to the bottom rather than stacked, so ItemSpacing drift cannot
    // push the last control past the window edge.
    const float footerHeight = 30.0f + ImGui::GetTextLineHeight() + kSpace5 + kSpace4;
    ImGui::SetCursorPosX(kSpace2);
    ImGui::BeginChild("##sessionList", ImVec2(width - kSpace2 * 2.0f, -footerHeight));

    std::vector<SessionSummary> sessions;
    bool loading = false;
    {
        std::lock_guard<std::mutex> lock(sessionsMutex_);
        sessions = sessions_;
        loading = sessionsLoading_;
    }

    if (sessions.empty()) {
        ImGui::SetCursorPosX(kSpace2);
        const FontScope font(fonts_.caption);
        wrapped(loading ? "Loading\xE2\x80\xA6"
                        : (signedIn_ ? "No sessions yet." : "Sign in to see your sessions."),
                kTextFaint);
    }

    // Rows are drawn by hand rather than with Selectable: two lines of text at
    // different sizes need one shared hit box, and moving the layout cursor
    // around a Selectable fights the child window's scrolling.
    const float rowWidth = ImGui::GetContentRegionAvail().x;
    const float rowHeight = ImGui::GetTextLineHeight() + (fonts_.caption ? fonts_.caption->FontSize : 11.0f) +
                            kSpace3 + 2.0f;

    for (const SessionSummary& session : sessions) {
        ImGui::PushID(session.id.c_str());
        const bool selected = session.id == activeSessionId_;
        const ImVec2 origin = ImGui::GetCursorScreenPos();

        ImGui::BeginDisabled(streaming && !selected);
        const bool clicked = ImGui::InvisibleButton("##row", ImVec2(rowWidth, rowHeight));
        ImGui::EndDisabled();
        const bool hovered = ImGui::IsItemHovered();
        if (clicked) activateSession(session);

        ImDrawList* draw = ImGui::GetWindowDrawList();
        const ImVec2 corner(origin.x + rowWidth, origin.y + rowHeight);
        if (selected) {
            draw->AddRectFilled(origin, corner, ImGui::GetColorU32(kSurfaceHover), kRadiusMd);
            draw->AddRectFilled(ImVec2(origin.x, origin.y + kSpace1),
                                ImVec2(origin.x + 2.0f, corner.y - kSpace1),
                                ImGui::GetColorU32(kText), kRadiusFull);
        } else if (hovered) {
            draw->AddRectFilled(origin, corner, ImGui::GetColorU32(kSurfaceFaint), kRadiusMd);
        }

        const float textX = origin.x + kSpace3;
        const float textWidth = rowWidth - kSpace3 * 2.0f;
        {
            const FontScope font(fonts_.medium);
            draw->AddText(fonts_.medium ? fonts_.medium : nullptr,
                          fonts_.medium ? fonts_.medium->FontSize : 0.0f,
                          ImVec2(textX, origin.y + kSpace2 - 2.0f),
                          ImGui::GetColorU32(selected ? kText : kTextMuted),
                          elide(session.title, textWidth).c_str());
        }
        if (fonts_.caption) {
            draw->AddText(fonts_.caption, fonts_.caption->FontSize,
                          ImVec2(textX, origin.y + kSpace2 + ImGui::GetTextLineHeight() - 3.0f),
                          ImGui::GetColorU32(kTextFaint), session.lastActivityAt.substr(0, 10).c_str());
        }

        ImGui::PopID();
    }

    ImGui::EndChild();

    // ---- footer ----------------------------------------------------------
    ImGui::SetCursorPos(ImVec2(kSpace4, ImGui::GetWindowHeight() - footerHeight));
    hairline();

    ImGui::SetCursorPos(ImVec2(kSpace4, ImGui::GetWindowHeight() - footerHeight + kSpace3));
    {
        const FontScope font(fonts_.caption);
        const double credits = credits_.load();
        if (credits >= 0) {
            char buffer[64];
            std::snprintf(buffer, sizeof(buffer), "%.2f credits", credits);
            statusDot(credits > 1.0 ? kSuccess : kWarning, 0.18f);
            text(buffer, kTextMuted);
        } else {
            statusDot(signedIn_ ? kTextFaint : kDanger, 0.18f);
            text(signedIn_ ? "credits unavailable" : "signed out", kTextFaint);
        }
    }

    ImGui::SetCursorPos(ImVec2(kSpace4, ImGui::GetWindowHeight() - 30.0f - kSpace3));
    if (ghostButton("Settings", ImVec2(width - kSpace4 * 2.0f, 30.0f))) showSettings_ = true;

    ImGui::EndChild();
}

// ---------------------------------------------------------------------------
// Main column
// ---------------------------------------------------------------------------

void App::drawMainColumn() {
    ImGui::BeginChild("##main", ImVec2(0, 0), ImGuiChildFlags_None,
                      ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);

    if (!signedIn_) {
        drawSignedOutState();
        ImGui::EndChild();
        return;
    }

    drawTopBar();

    const float composerHeight = ImGui::GetTextLineHeight() * 3.0f + 34.0f + kSpace4 * 2.0f + kSpace2;
    const float statusHeight = ImGui::GetTextLineHeight() + kSpace3;

    ImGui::BeginChild("##transcript", ImVec2(0, -(composerHeight + statusHeight)),
                      ImGuiChildFlags_None);
    drawTranscript();
    ImGui::EndChild();

    drawComposer();
    drawStatusBar();

    ImGui::EndChild();
}

void App::drawTopBar() {
    const float height = kTopBarHeight;
    const ImVec2 origin = ImGui::GetCursorScreenPos();
    const float width = ImGui::GetContentRegionAvail().x;

    bool streaming = false;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        streaming = streaming_;
    }

    // Title and controls are positioned absolutely against the bar's centre
    // line. Laying them out with SameLine couples their baselines, which is
    // what left the combo sitting a few pixels below the button.
    const float frameHeight = ImGui::GetFrameHeight();
    const float controlsY = (height - frameHeight) * 0.5f;

    ImGui::SetCursorPos(ImVec2(kSpace5, (height - ImGui::GetTextLineHeight()) * 0.5f));
    {
        const FontScope font(fonts_.heading);
        const std::string title = activeSessionId_.empty() ? "New session" : activeSessionTitle_;
        text(elide(title, width * 0.45f), kText);
    }

    // Mode and model belong to the session, so they live in the session's bar
    // rather than beside the composer, where they read as message options.
    const float modelWidth = 168.0f;
    const float modeWidth = 78.0f;
    const float controlsWidth = modelWidth + modeWidth + kSpace2;

    ImGui::SetCursorPos(ImVec2(width - controlsWidth - kSpace5, controlsY));

    const bool planMode = settings_.mode == "PLAN";
    ImGui::BeginDisabled(streaming);
    {
        // Stable widget id: without the "##mode" suffix the label *is* the id,
        // so toggling would change the id and shuffle keyboard focus.
        const ImVec4 tint = planMode ? kWarning : kSuccess;
        const ColorScope colors(ImGuiCol_Button, withAlpha(tint, 0.12f), ImGuiCol_ButtonHovered,
                                withAlpha(tint, 0.22f), ImGuiCol_Text, tint);
        ImGui::PushStyleColor(ImGuiCol_Border, withAlpha(tint, 0.35f));
        const FontScope font(fonts_.medium);
        if (ImGui::Button(planMode ? "PLAN##mode" : "BUILD##mode", ImVec2(modeWidth, frameHeight))) {
            settings_.mode = planMode ? "BUILD" : "PLAN";
            settings_.save();
        }
        ImGui::PopStyleColor();
    }
    if (ImGui::IsItemHovered()) {
        ImGui::SetTooltip(planMode ? "PLAN â read-only tools. Click for BUILD."
                                   : "BUILD â writes and shell enabled. Click for PLAN.");
    }

    ImGui::SameLine(0.0f, kSpace2);
    ImGui::SetNextItemWidth(modelWidth);
    if (ImGui::BeginCombo("##model", std::string(modelDisplayName(settings_.model)).c_str())) {
        for (const ModelInfo& model : kModels) {
            if (model.id.empty()) continue;
            const std::string id(model.id);
            const bool selected = id == settings_.model;
            if (ImGui::Selectable(std::string(model.displayName).c_str(), selected)) {
                settings_.model = id;
                settings_.save();
            }
            if (ImGui::IsItemHovered()) ImGui::SetTooltip("%s", std::string(model.note).c_str());
            if (selected) ImGui::SetItemDefaultFocus();
        }
        ImGui::EndCombo();
    }
    ImGui::EndDisabled();

    // ---- bottom hairline -------------------------------------------------
    ImGui::GetWindowDrawList()->AddLine(ImVec2(origin.x, origin.y + height),
                                        ImVec2(origin.x + width, origin.y + height),
                                        ImGui::GetColorU32(kBorder));
    ImGui::SetCursorPos(ImVec2(0.0f, height + 1.0f));
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

void App::drawTranscript() {
    std::vector<Message> snapshot;
    std::string status;
    bool streaming = false;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        snapshot = messages_;
        status = streamStatus_;
        streaming = streaming_;
    }

    if (snapshot.empty()) {
        drawEmptyState();
        return;
    }

    const float available = ImGui::GetContentRegionAvail().x;
    const float column = std::min(available - kSpace5 * 2.0f, kContentMaxWidth);
    const float inset = std::max(kSpace5, (available - column) * 0.5f);

    space(kSpace5);
    for (size_t i = 0; i < snapshot.size(); ++i) {
        ImGui::PushID(static_cast<int>(i));
        ImGui::SetCursorPosX(inset);
        drawMessage(snapshot[i], column);
        ImGui::PopID();
        space(kSpace5);
    }

    if (streaming && !status.empty()) {
        ImGui::SetCursorPosX(inset);
        {
            const FontScope font(fonts_.caption);
            text(status, kTextMuted);
        }
        space(kSpace1);
        ImGui::SetCursorPosX(inset);
        workingTrack(column);
        space(kSpace4);
    }

    if (scrollToBottom_.exchange(false)) ImGui::SetScrollHereY(1.0f);
}

void App::drawMessage(const Message& message, float column) {
    const bool isUser = message.role == "user";

    if (isUser) {
        // A right-aligned bubble, sized to its content up to a limit. The
        // asymmetry alone tells you who is speaking, so no label is needed.
        const std::string body = message.plainText();
        const float maxBubble = column * 0.78f;
        const float padding = kSpace3;
        ImGui::PushTextWrapPos(0.0f);
        // Slack matters: sized to exactly the measured width, the last word
        // wraps to a second line on a rounding difference.
        const float natural = ImGui::CalcTextSize(body.c_str()).x + padding * 2.0f + 6.0f;
        ImGui::PopTextWrapPos();
        const float bubble = std::min(std::max(natural, 120.0f), maxBubble);

        ImGui::SetCursorPosX(ImGui::GetCursorPosX() + (column - bubble));

        const ColorScope background(ImGuiCol_ChildBg, kSurface);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(padding, kSpace2 + 2.0f));
        ImGui::BeginChild("##user", ImVec2(bubble, 0),
                          ImGuiChildFlags_AutoResizeY | ImGuiChildFlags_AlwaysUseWindowPadding |
                              ImGuiChildFlags_Borders);
        // 0.0f means "the content region's right edge". Passing a width here
        // instead would be measured from the window origin, so the padding
        // would be subtracted twice and the text would wrap early.
        ImGui::PushTextWrapPos(0.0f);
        ImGui::TextUnformatted(body.c_str());
        ImGui::PopTextWrapPos();
        ImGui::EndChild();
        ImGui::PopStyleVar();
        return;
    }

    // ---- assistant -------------------------------------------------------
    ImGui::BeginGroup();
    ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + column);

    if (message.metadata.compactionDropped > 0) {
        const FontScope font(fonts_.caption);
        const ColorScope color(ImGuiCol_Text, kWarning);
        ImGui::Text("Context compacted — %d earlier messages summarised",
                    message.metadata.compactionDropped);
        space(kSpace2);
    }

    for (const Part& part : message.parts) {
        switch (part.kind) {
            case PartKind::Text:
                if (!part.text.empty()) drawMarkdown(part.text, column);
                break;
            case PartKind::Reasoning:
                if (!part.text.empty()) {
                    const FontScope font(fonts_.caption);
                    wrapped(part.text, kTextFaint);
                }
                break;
            case PartKind::Tool:
                drawToolCall(part.tool, column);
                break;
        }
    }

    if (!message.errorText.empty()) {
        space(kSpace2);
        const ImVec2 origin = ImGui::GetCursorScreenPos();
        ImGui::GetWindowDrawList()->AddRectFilled(
            origin, ImVec2(origin.x + 2.0f, origin.y + ImGui::GetTextLineHeight()),
            ImGui::GetColorU32(kDanger), 1.0f);
        ImGui::Indent(kSpace2);
        wrapped(message.errorText, kDanger);
        ImGui::Unindent(kSpace2);
    }

    // Footer: what the turn cost and how full the window is.
    const TurnMetadata& meta = message.metadata;
    if (!message.streaming && (meta.hasUsage || meta.durationMs > 0)) {
        space(kSpace2);
        std::string footer;
        if (meta.durationMs > 0) footer += formatDuration(meta.durationMs);
        if (meta.hasUsage) {
            if (!footer.empty()) footer += "   ";
            footer += humanCount(meta.inputTokens) + " in · " + humanCount(meta.outputTokens) + " out";
        }
        if (meta.contextWindow > 0) {
            const int percent =
                static_cast<int>(100.0 * static_cast<double>(meta.contextEstimatedTokens) /
                                 static_cast<double>(meta.contextWindow));
            footer += "   ctx " + std::to_string(percent) + "%";
        }
        const FontScope font(fonts_.caption);
        text(footer, kTextFaint);
    }

    ImGui::PopTextWrapPos();
    ImGui::EndGroup();
}

void App::drawToolCall(const ToolCall& tool, float column) {
    const bool expanded = expandedTools_.count(tool.toolCallId) > 0;
    const ImVec4 dotColor = toolStateColor(tool.state);

    space(kSpace2);
    ImGui::PushID(tool.toolCallId.c_str());

    const ColorScope background(ImGuiCol_ChildBg, expanded ? kSurface : kSurfaceFaint);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(kSpace3, kSpace2 + 1.0f));
    ImGui::BeginChild("##tool", ImVec2(column, 0),
                      ImGuiChildFlags_AutoResizeY | ImGuiChildFlags_AlwaysUseWindowPadding |
                          ImGuiChildFlags_Borders);

    // ---- header row: dot, name, argument, timing -------------------------
    const float innerWidth = ImGui::GetContentRegionAvail().x;
    statusDot(dotColor, 0.20f);

    {
        const FontScope font(fonts_.medium);
        text(tool.toolName, kText);
    }
    ImGui::SameLine(0.0f, kSpace2);

    std::string timing;
    if (tool.finishedMs > 0 && tool.startedMs > 0 && tool.finishedMs >= tool.startedMs) {
        timing = formatDuration(tool.finishedMs - tool.startedMs);
    }
    const float timingWidth = timing.empty() ? 0.0f : ImGui::CalcTextSize(timing.c_str()).x + kSpace3;

    {
        const FontScope font(fonts_.mono);
        const float used = ImGui::GetCursorPosX();
        const float room = innerWidth - used + kSpace3 - timingWidth;
        text(elide(splitLines(toolSummary(tool)).front(), room), kTextMuted);
    }

    if (!timing.empty()) {
        ImGui::SameLine();
        ImGui::SetCursorPosX(innerWidth - ImGui::CalcTextSize(timing.c_str()).x + kSpace3);
        const FontScope font(fonts_.caption);
        text(timing, kTextFaint);
    }

    // ---- result line, with the disclosure toggle riding its right edge ----
    // Giving the toggle its own row cost a line of vertical space in every
    // card, and a card is the most repeated element on the screen.
    {
        const FontScope font(fonts_.caption);
        const char* toggleLabel = expanded ? "Hide" : "Details";
        const float toggleWidth = ImGui::CalcTextSize(toggleLabel).x + kSpace3;
        const bool settled =
            tool.state == ToolState::OutputAvailable || tool.state == ToolState::OutputError;

        if (settled) {
            const std::string preview = splitLines(toolResultPreview(tool)).front();
            text(elide(preview, innerWidth - toggleWidth - kSpace3),
                 tool.state == ToolState::OutputError ? kDanger : kTextFaint);
            ImGui::SameLine();
        }

        ImGui::SetCursorPosX(ImGui::GetCursorPosX() + ImGui::GetContentRegionAvail().x - toggleWidth);
        ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(kSpace2 * 0.5f, 1.0f));
        if (ghostButton(toggleLabel)) {
            if (expanded) expandedTools_.erase(tool.toolCallId);
            else expandedTools_.insert(tool.toolCallId);
        }
        ImGui::PopStyleVar();
    }

    if (expanded) {
        space(kSpace1);
        hairline();
        space(kSpace2);

        {
            const FontScope font(fonts_.caption);
            text("INPUT", kTextFaint);
        }
        {
            const FontScope font(fonts_.mono);
            wrapped(tool.input.dump(2), kTextMuted);
        }

        if (tool.state == ToolState::OutputAvailable) {
            space(kSpace2);
            {
                const FontScope font(fonts_.caption);
                text("OUTPUT", kTextFaint);
            }
            const FontScope font(fonts_.mono);
            wrapped(truncateForModel(tool.output.dump(2), 4000), kTextMuted);
        } else if (tool.state == ToolState::OutputError) {
            space(kSpace2);
            const FontScope font(fonts_.mono);
            wrapped(tool.errorText, kDanger);
        }
    }

    ImGui::EndChild();
    ImGui::PopStyleVar();
    ImGui::PopID();
    space(kSpace1);
}

void App::drawMarkdown(const std::string& value, float column) {
    size_t position = 0;
    int blockIndex = 0;

    const auto drawProse = [](const std::string& chunk) {
        const std::string trimmed = trim(chunk);
        if (!trimmed.empty()) ImGui::TextUnformatted(trimmed.c_str());
    };

    while (position < value.size()) {
        const size_t fence = value.find("```", position);
        if (fence == std::string::npos) {
            drawProse(value.substr(position));
            break;
        }
        if (fence > position) drawProse(value.substr(position, fence - position));

        const size_t headerEnd = value.find('\n', fence);
        if (headerEnd == std::string::npos) {
            drawProse(value.substr(fence));
            break;
        }
        const std::string language = trim(value.substr(fence + 3, headerEnd - fence - 3));
        const size_t close = value.find("```", headerEnd + 1);
        const std::string code = value.substr(
            headerEnd + 1, (close == std::string::npos ? value.size() : close) - headerEnd - 1);

        ImGui::PushID(blockIndex++);
        space(kSpace3);

        const ColorScope background(ImGuiCol_ChildBg, kCanvas);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0.0f, 0.0f));
        ImGui::BeginChild("##code", ImVec2(column, 0),
                          ImGuiChildFlags_AutoResizeY | ImGuiChildFlags_Borders);

        // Header strip: language on the left, copy on the right.
        ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, ImVec2(0.0f, 0.0f));
        ImGui::SetCursorPos(ImVec2(kSpace3, kSpace2 - 2.0f));
        {
            const FontScope font(fonts_.caption);
            text(language.empty() ? "code" : language, kTextFaint);
        }
        ImGui::SameLine();
        {
            const FontScope font(fonts_.caption);
            const float copyWidth = ImGui::CalcTextSize("Copy").x + kSpace3;
            ImGui::SetCursorPosX(column - copyWidth - kSpace2);
            ImGui::SetCursorPosY(kSpace2 - 4.0f);
            ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(kSpace2 * 0.5f, 2.0f));
            if (ghostButton("Copy")) {
                ImGui::SetClipboardText(code.c_str());
                toast("Copied to clipboard.");
            }
            ImGui::PopStyleVar();
        }
        ImGui::PopStyleVar();

        ImGui::SetCursorPosX(kSpace3);
        hairline(0.0f);
        space(kSpace2);

        ImGui::SetCursorPosX(kSpace3);
        ImGui::BeginChild("##codebody", ImVec2(column - kSpace3, 0),
                          ImGuiChildFlags_AutoResizeY, ImGuiWindowFlags_HorizontalScrollbar);
        {
            const FontScope font(fonts_.mono);
            const ColorScope color(ImGuiCol_Text, kText);
            ImGui::TextUnformatted(code.c_str());
        }
        ImGui::EndChild();
        space(kSpace2);

        ImGui::EndChild();
        ImGui::PopStyleVar();
        space(kSpace3);
        ImGui::PopID();

        if (close == std::string::npos) break;
        position = close + 3;
    }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

void App::drawComposer() {
    bool streaming = false;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        streaming = streaming_;
    }

    const float available = ImGui::GetContentRegionAvail().x;
    const float column = std::min(available - kSpace5 * 2.0f, kContentMaxWidth);
    const float inset = std::max(kSpace5, (available - column) * 0.5f);

    ImGui::SetCursorPosX(inset);

    const ImVec2 cardOrigin = ImGui::GetCursorScreenPos();
    const float inputHeight = ImGui::GetTextLineHeight() * 3.0f;
    const float cardHeight = inputHeight + 34.0f + kSpace3 * 2.0f;

    const ColorScope background(ImGuiCol_ChildBg, kSurface);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(kSpace3, kSpace3));
    ImGui::BeginChild("##composerCard", ImVec2(column, cardHeight),
                      ImGuiChildFlags_AlwaysUseWindowPadding | ImGuiChildFlags_Borders);

    if (focusComposer_ && !ImGui::IsAnyItemActive()) {
        ImGui::SetKeyboardFocusHere();
        focusComposer_ = false;
    }

    // The text area is styled to disappear into the card; the card is the
    // control, which is why the focus ring is drawn around the card below.
    {
        const ColorScope frame(ImGuiCol_FrameBg, ImVec4(0, 0, 0, 0));
        ImGui::PushStyleVar(ImGuiStyleVar_FrameBorderSize, 0.0f);
        ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(0.0f, 0.0f));
        ImGui::SetNextItemWidth(-FLT_MIN);
        if (ImGui::InputTextMultiline("##composer", composerBuffer_.data(), composerBuffer_.size(),
                                      ImVec2(-FLT_MIN, inputHeight),
                                      ImGuiInputTextFlags_EnterReturnsTrue |
                                          ImGuiInputTextFlags_CtrlEnterForNewLine) &&
            !streaming) {
            const std::string value(composerBuffer_.data());
            if (!trim(value).empty()) {
                submit(value);
                composerBuffer_.assign(composerBuffer_.size(), '\0');
            }
            focusComposer_ = true;
        }
        ImGui::PopStyleVar(2);
    }
    const bool inputActive = ImGui::IsItemActive();

    // Placeholder, drawn over the empty input.
    if (composerBuffer_[0] == '\0' && !inputActive) {
        const ImVec2 min = ImGui::GetItemRectMin();
        ImGui::GetWindowDrawList()->AddText(ImVec2(min.x + 1.0f, min.y),
                                           ImGui::GetColorU32(kTextFaint),
                                           "Ask anything, or describe a change\xE2\x80\xA6");
    }

    // ---- action row ------------------------------------------------------
    ImGui::SetCursorPosY(ImGui::GetCursorPosY() + kSpace2);
    {
        const FontScope font(fonts_.caption);
        text(streaming ? "Working\xE2\x80\xA6 press Stop to interrupt"
                       : "Enter to send · Ctrl+Enter for a new line",
             kTextFaint);
    }

    ImGui::SameLine();
    const float actionWidth = 92.0f;
    ImGui::SetCursorPosX(ImGui::GetCursorPosX() + ImGui::GetContentRegionAvail().x - actionWidth);
    ImGui::SetCursorPosY(ImGui::GetCursorPosY() - kSpace1);

    if (streaming) {
        if (dangerButton("Stop", ImVec2(actionWidth, 30.0f))) stopTurn();
    } else {
        const FontScope font(fonts_.medium);
        if (primaryButton("Send", ImVec2(actionWidth, 30.0f))) {
            const std::string value(composerBuffer_.data());
            if (!trim(value).empty()) {
                submit(value);
                composerBuffer_.assign(composerBuffer_.size(), '\0');
            }
            focusComposer_ = true;
        }
    }

    ImGui::EndChild();
    ImGui::PopStyleVar();

    // Focus ring around the whole card.
    if (inputActive) {
        ImGui::GetWindowDrawList()->AddRect(cardOrigin,
                                            ImVec2(cardOrigin.x + column, cardOrigin.y + cardHeight),
                                            ImGui::GetColorU32(kFocusRing), kRadiusMd,
                                            0, 1.0f);
    }
}

void App::drawStatusBar() {
    ImGui::SetCursorPosX(0.0f);
    hairline();
    ImGui::SetCursorPosX(kSpace5);
    ImGui::SetCursorPosY(ImGui::GetCursorPosY() + kSpace1);

    const FontScope font(fonts_.caption);

    std::string line = settings_.projectDir;
    const float budget = ImGui::GetContentRegionAvail().x * 0.45f;
    line = elide(line, budget);

    const bool localApi = settings_.apiUrl.find("localhost") != std::string::npos ||
                          settings_.apiUrl.find("127.0.0.1") != std::string::npos;
    statusDot(localApi ? kWarning : kSuccess, 0.16f);
    text(line, kTextFaint);

    ImGui::SameLine(0.0f, kSpace3);
    text("·", kTextFaint);
    ImGui::SameLine(0.0f, kSpace3);
    text(settings_.apiUrl, kTextFaint);

    // Only surface the auto-approve toggles when they are on — the interesting
    // state is the loosened one.
    std::string relaxed;
    if (settings_.autoApproveWrites) relaxed += "writes";
    if (settings_.autoApproveBash) relaxed += relaxed.empty() ? "shell" : ", shell";
    if (settings_.autoApproveWeb) relaxed += relaxed.empty() ? "web" : ", web";
    if (!relaxed.empty()) {
        ImGui::SameLine(0.0f, kSpace3);
        text("·", kTextFaint);
        ImGui::SameLine(0.0f, kSpace3);
        text("auto-approving " + relaxed, kWarning);
    }
}

// ---------------------------------------------------------------------------
// Empty and signed-out states
// ---------------------------------------------------------------------------

void App::drawEmptyState() {
    const float available = ImGui::GetContentRegionAvail().x;
    const float column = std::min(available - kSpace5 * 2.0f, kContentMaxWidth);
    const float inset = std::max(kSpace5, (available - column) * 0.5f);

    // Roughly optically centred: the block below is about 260px tall.
    space(std::max(kSpace6, (ImGui::GetContentRegionAvail().y - 260.0f) * 0.40f));

    ImGui::SetCursorPosX(inset);
    {
        // Weight 300 at size: the language never shouts at scale.
        const FontScope font(fonts_.light);
        text("What are we building?", kText);
    }

    space(kSpace3);
    ImGui::SetCursorPosX(inset);
    ImGui::PushTextWrapPos(inset + column);
    wrapped("Tools run on this machine against " + settings_.projectDir +
                ". PLAN keeps them read-only; BUILD allows writes and shell commands.",
            kTextSoft);
    ImGui::PopTextWrapPos();

    space(kSpace5);
    for (const char* suggestion : kSuggestions) {
        ImGui::SetCursorPosX(inset);
        ImGui::PushID(suggestion);
        const ColorScope colors(ImGuiCol_Button, kSurfaceFaint, ImGuiCol_ButtonHovered,
                                kSurfaceHover, ImGuiCol_Text, kTextMuted);
        if (ImGui::Button(suggestion, ImVec2(column, 32.0f))) {
            std::snprintf(composerBuffer_.data(), composerBuffer_.size(), "%s", suggestion);
            focusComposer_ = true;
        }
        ImGui::PopID();
        space(kSpace2);
    }
}

void App::drawSignedOutState() {
    const float available = ImGui::GetContentRegionAvail().x;
    const float column = std::min(available - kSpace5 * 2.0f, 460.0f);
    const float inset = std::max(kSpace5, (available - column) * 0.5f);

    space(ImGui::GetContentRegionAvail().y * 0.28f);
    ImGui::SetCursorPosX(inset);
    {
        const FontScope font(fonts_.light);
        text("Sign in to DarkCode", kText);
    }

    space(kSpace3);
    ImGui::SetCursorPosX(inset);
    ImGui::PushTextWrapPos(inset + column);
    wrapped("The desktop app reads the same credentials as the CLI. In a terminal, run darkcode "
            "and use /login, then come back here.",
            kTextSoft);
    ImGui::PopTextWrapPos();

    space(kSpace5);
    ImGui::SetCursorPosX(inset);
    if (primaryButton("I have signed in", ImVec2(170.0f, 34.0f))) {
        api_.reloadAuthFromDisk();
        signedIn_ = api_.signedIn();
        if (signedIn_) {
            refreshSessions();
            refreshCredits();
            toast("Signed in.");
        } else {
            toast("No credentials found in " + authFilePath(), true);
        }
    }
    ImGui::SameLine(0.0f, kSpace2);
    if (ghostButton("Settings", ImVec2(110.0f, 34.0f))) showSettings_ = true;
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

void App::drawPermissionModal() {
    static bool wasOpen = false;
    static int openedAtFrame = 0;
    const bool isOpen = permissions_.hasPending();

    if (isOpen && !wasOpen) {
        ImGui::OpenPopup("Permission required");
        openedAtFrame = ImGui::GetFrameCount();
        // Drop whatever is already in the input queue. Without this, a key
        // pressed just before the prompt appeared (Enter from the composer, say)
        // lands on the freshly-focused button and answers a security question
        // the user never saw.
        ImGui::GetIO().ClearEventsQueue();
        ImGui::GetIO().ClearInputKeys();
    }
    wasOpen = isOpen;
    if (!isOpen) return;

    // Ignore input for a couple of frames after opening, for the same reason.
    const bool armed = ImGui::GetFrameCount() > openedAtFrame + 2;
    const PermissionRequest request = permissions_.pending();

    ImGui::SetNextWindowSize(ImVec2(620, 0), ImGuiCond_Always);
    ImGui::SetNextWindowPos(ImGui::GetMainViewport()->GetCenter(), ImGuiCond_Always, ImVec2(0.5f, 0.5f));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(kSpace5, kSpace5));
    const ColorScope background(ImGuiCol_PopupBg, kSurface);

    if (ImGui::BeginPopupModal("Permission required", nullptr,
                               ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove |
                                   ImGuiWindowFlags_NoTitleBar)) {
        {
            const FontScope font(fonts_.caption);
            text("PERMISSION REQUIRED", kAccent);
        }
        space(kSpace2);
        {
            const FontScope font(fonts_.heading);
            text(request.title, kText);
        }

        space(kSpace3);
        {
            const ColorScope subject(ImGuiCol_ChildBg, kCanvas);
            ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(kSpace3, kSpace3));
            ImGui::BeginChild("##subject", ImVec2(0, 0),
                              ImGuiChildFlags_AutoResizeY | ImGuiChildFlags_AlwaysUseWindowPadding |
                                  ImGuiChildFlags_Borders);
            // Scoped so the pop happens inside this child. ImGui balances its
            // stacks per window, so a guard that outlives EndChild pops into
            // the wrong one.
            {
                const FontScope font(fonts_.mono);
                wrapped(request.subject, kText);
            }
            ImGui::EndChild();
            ImGui::PopStyleVar();
        }

        if (!request.detail.empty()) {
            space(kSpace3);
            const char* detailLabel = "NEW CONTENTS";
            if (request.kind == PermissionKind::Bash) detailLabel = "CONTEXT";
            else if (request.kind == PermissionKind::Web) detailLabel = "ABOUT THIS REQUEST";
            {
                const FontScope font(fonts_.caption);
                text(detailLabel, kTextFaint);
            }
            space(kSpace1);

            // A short explanation gets a box that fits it; a file preview gets a
            // fixed, scrollable one. A one-line sentence in a 160px well looks
            // like something failed to load.
            const bool brief = request.detail.size() < 240 &&
                               request.detail.find('\n') == std::string::npos;

            const ColorScope detail(ImGuiCol_ChildBg, kCanvas);
            ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(kSpace3, kSpace3));
            ImGui::BeginChild("##detail", ImVec2(0, brief ? 0.0f : 180.0f),
                              (brief ? ImGuiChildFlags_AutoResizeY : ImGuiChildFlags_None) |
                                  ImGuiChildFlags_AlwaysUseWindowPadding | ImGuiChildFlags_Borders,
                              brief ? ImGuiWindowFlags_None : ImGuiWindowFlags_HorizontalScrollbar);
            {
                const FontScope font(fonts_.mono);
                const ColorScope color(ImGuiCol_Text, kTextMuted);
                if (brief) {
                    ImGui::PushTextWrapPos(0.0f);
                    ImGui::TextUnformatted(request.detail.c_str());
                    ImGui::PopTextWrapPos();
                } else {
                    ImGui::TextUnformatted(truncateForModel(request.detail, 8000).c_str());
                }
            }
            ImGui::EndChild();
            ImGui::PopStyleVar();
        }

        space(kSpace5);
        ImGui::BeginDisabled(!armed);

        if (primaryButton("Allow once", ImVec2(130, 32)) && armed) {
            permissions_.resolve(PermissionDecision::AllowOnce);
            ImGui::CloseCurrentPopup();
        }
        ImGui::SameLine(0.0f, kSpace2);
        if (secondaryButton(request.sessionLabel.c_str(), ImVec2(0, 32)) && armed) {
            permissions_.resolve(PermissionDecision::AllowSession);
            ImGui::CloseCurrentPopup();
        }

        ImGui::SameLine();
        const float denyWidth = 92.0f;
        ImGui::SetCursorPosX(ImGui::GetCursorPosX() + ImGui::GetContentRegionAvail().x - denyWidth);
        const bool denied = dangerButton("Deny", ImVec2(denyWidth, 32));
        // Deny is the default-focused item: if keyboard navigation does answer
        // this dialog, it must answer it the safe way.
        ImGui::SetItemDefaultFocus();
        if (armed && (denied || ImGui::IsKeyPressed(ImGuiKey_Escape))) {
            permissions_.resolve(PermissionDecision::Deny);
            ImGui::CloseCurrentPopup();
        }

        ImGui::EndDisabled();
        ImGui::EndPopup();
    }
    ImGui::PopStyleVar();
}

void App::drawSettingsWindow() {
    ImGui::SetNextWindowSize(ImVec2(600, 640), ImGuiCond_FirstUseEver);
    ImGui::SetNextWindowPos(ImGui::GetMainViewport()->GetCenter(), ImGuiCond_FirstUseEver,
                            ImVec2(0.5f, 0.5f));
    const ColorScope background(ImGuiCol_WindowBg, kSurface);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(kSpace5, kSpace5));

    if (ImGui::Begin("Settings", &showSettings_, ImGuiWindowFlags_NoCollapse)) {
        const auto sectionLabel = [this](const char* value) {
            space(kSpace3);
            const FontScope font(fonts_.caption);
            text(value, kTextFaint);
            space(kSpace1);
        };
        const auto fieldLabel = [this](const char* value) {
            const FontScope font(fonts_.medium);
            text(value, kText);
        };

        sectionLabel("CONNECTION");
        fieldLabel("API URL");
        ImGui::SetNextItemWidth(-FLT_MIN);
        ImGui::InputText("##apiUrl", apiUrlBuffer_.data(), apiUrlBuffer_.size());
        if (settings_.apiUrlFromEnv) {
            const FontScope font(fonts_.caption);
            ImGui::PushTextWrapPos(0.0f);
            wrapped("DARKCODE_API_URL is set, so this session talks to " + settings_.apiUrl +
                        ". The value above applies once that variable is gone.",
                    kWarning);
            ImGui::PopTextWrapPos();
        }

        space(kSpace3);
        fieldLabel("Project directory");
        {
            const FontScope font(fonts_.caption);
            text("Every tool resolves paths against this, and cannot escape it.", kTextFaint);
        }
        const float browseWidth = 100.0f;
        ImGui::SetNextItemWidth(ImGui::GetContentRegionAvail().x - browseWidth - kSpace2);
        ImGui::InputText("##projectDir", projectDirBuffer_.data(), projectDirBuffer_.size());
        ImGui::SameLine(0.0f, kSpace2);
        if (secondaryButton("Browse\xE2\x80\xA6", ImVec2(browseWidth, 0))) {
            const std::string chosen = browseForFolder(trim(projectDirBuffer_.data()));
            if (!chosen.empty()) {
                std::snprintf(projectDirBuffer_.data(), projectDirBuffer_.size(), "%s", chosen.c_str());
            }
        }

        if (findBashPath().empty()) {
            space(kSpace2);
            const FontScope font(fonts_.caption);
            ImGui::PushTextWrapPos(0.0f);
            wrapped("bash was not found. The shell tool needs Git for Windows installed.", kWarning);
            ImGui::PopTextWrapPos();
        }

        sectionLabel("PERMISSIONS");
        compactCheckbox("Auto-approve file reads", &settings_.autoApproveReads);
        compactCheckbox("Auto-approve file writes", &settings_.autoApproveWrites);
        compactCheckbox("Auto-approve shell commands", &settings_.autoApproveBash);
        compactCheckbox("Auto-approve web fetches", &settings_.autoApproveWeb);
        {
            const FontScope font(fonts_.caption);
            ImGui::PushTextWrapPos(0.0f);
            wrapped("Secrets (.env, keys, ~/.ssh, credential stores) are refused whatever these say. "
                    "So are destructive shell commands and cloud metadata endpoints.",
                    kTextFaint);
            ImGui::PopTextWrapPos();
        }

        sectionLabel("CONTEXT");
        compactCheckbox("Send project context (git branch, AGENTS.md / CLAUDE.md)",
                        &settings_.sendProjectContext);

        sectionLabel("API KEYS");
        {
            const FontScope font(fonts_.caption);
            ImGui::PushTextWrapPos(0.0f);
            wrapped("Stored in ~/.darkcode/api-keys.json, shared with the CLI. A key of your own is "
                    "never metered as credits.",
                    kTextFaint);
            ImGui::PopTextWrapPos();
        }
        space(kSpace2);

        for (size_t i = 0; i < kByokProviders.size(); ++i) {
            ImGui::PushID(static_cast<int>(i));
            fieldLabel(std::string(kByokProviders[i].label).c_str());
            ImGui::SetNextItemWidth(-FLT_MIN);
            ImGui::InputTextWithHint("##key", std::string(kByokProviders[i].placeholder).c_str(),
                                     apiKeyBuffers_[i].data(), apiKeyBuffers_[i].size(),
                                     ImGuiInputTextFlags_Password);
            ImGui::PopID();
            space(kSpace1);
        }

        sectionLabel("ACCOUNT");
        if (secondaryButton("Reload credentials from disk")) {
            api_.reloadAuthFromDisk();
            signedIn_ = api_.signedIn();
            if (signedIn_) {
                refreshSessions();
                refreshCredits();
            }
        }
        ImGui::SameLine(0.0f, kSpace2);
        if (dangerButton("Sign out")) {
            std::thread([this] {
                api_.signOut();
                signedIn_ = false;
                credits_ = -1.0;
                {
                    std::lock_guard<std::mutex> lock(sessionsMutex_);
                    sessions_.clear();
                }
                toast("Signed out.");
            }).detach();
        }

        space(kSpace5);
        hairline();
        space(kSpace3);

        if (primaryButton("Save", ImVec2(110, 32))) {
            std::string url = trim(apiUrlBuffer_.data());
            while (!url.empty() && url.back() == '/') url.pop_back();
            settings_.apiUrlStored = url;
            // An environment override stays in force for this run.
            if (!settings_.apiUrlFromEnv) settings_.apiUrl = url;
            settings_.projectDir = trim(projectDirBuffer_.data());
            settings_.save();

            std::map<std::string, std::string> keys;
            for (size_t i = 0; i < kByokProviders.size(); ++i) {
                const std::string value = trim(apiKeyBuffers_[i].data());
                if (!value.empty()) keys[std::string(kByokProviders[i].id)] = value;
            }
            saveApiKeys(keys);

            toast("Settings saved.");
            showSettings_ = false;
        }
        ImGui::SameLine(0.0f, kSpace2);
        if (ghostButton("Close", ImVec2(110, 32))) showSettings_ = false;
    }
    ImGui::End();
    ImGui::PopStyleVar();
}

void App::drawToast() {
    if (toastText_.empty()) return;

    const ImGuiViewport* viewport = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(ImVec2(viewport->WorkPos.x + viewport->WorkSize.x - kSpace5,
                                   viewport->WorkPos.y + viewport->WorkSize.y - kSpace5),
                            ImGuiCond_Always, ImVec2(1.0f, 1.0f));
    ImGui::SetNextWindowBgAlpha(0.98f);

    const ColorScope background(ImGuiCol_WindowBg, toastIsError_ ? ImVec4(0.180f, 0.075f, 0.086f, 1.0f)
                                                                 : kSurface);
    ImGui::PushStyleColor(ImGuiCol_Border, toastIsError_ ? withAlpha(kDanger, 0.5f) : kBorderStrong);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(kSpace3, kSpace3));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 1.0f);

    ImGui::Begin("##toast", nullptr,
                 ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove |
                     ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoSavedSettings |
                     ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoNav);

    statusDot(toastIsError_ ? kDanger : kSuccess, 0.18f);
    ImGui::PushTextWrapPos(420.0f);
    wrapped(toastText_, toastIsError_ ? kDanger : kText);
    ImGui::PopTextWrapPos();

    ImGui::End();
    ImGui::PopStyleVar(2);
    ImGui::PopStyleColor();
}

} // namespace dc
