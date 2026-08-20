// All rendering. Layout is hand-laid rather than docked: a fixed sidebar, a
// transcript that takes the remaining height, then the composer and a status
// line. Predictable, and it keeps the window free of chrome the user has to
// arrange before the app is usable.
#include "app.h"

#include <algorithm>
#include <cstdio>

#include "imgui.h"
#include "models.h"
#include "util.h"

namespace dc {
namespace {

using namespace theme;

constexpr float kSidebarWidth = 264.0f;

void textMuted(const std::string& text) {
    ImGui::PushStyleColor(ImGuiCol_Text, kTextMuted);
    ImGui::TextUnformatted(text.c_str());
    ImGui::PopStyleColor();
}

void wrappedMuted(const std::string& text) {
    ImGui::PushStyleColor(ImGuiCol_Text, kTextMuted);
    ImGui::TextWrapped("%s", text.c_str());
    ImGui::PopStyleColor();
}

void verticalSpace(float pixels) { ImGui::Dummy(ImVec2(0.0f, pixels)); }

/// A filled dot, used for tool status.
void statusDot(const ImVec4& color) {
    const float radius = ImGui::GetFontSize() * 0.22f;
    const ImVec2 cursor = ImGui::GetCursorScreenPos();
    const ImVec2 center(cursor.x + radius + 2.0f, cursor.y + ImGui::GetTextLineHeight() * 0.5f);
    ImGui::GetWindowDrawList()->AddCircleFilled(center, radius, ImGui::GetColorU32(color));
    ImGui::Dummy(ImVec2(radius * 2.0f + 6.0f, ImGui::GetTextLineHeight()));
    ImGui::SameLine(0.0f, 6.0f);
}

bool accentButton(const char* label, const ImVec2& size = ImVec2(0, 0)) {
    ImGui::PushStyleColor(ImGuiCol_Button, kAccent);
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, withAlpha(kAccent, 0.85f));
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, withAlpha(kAccent, 0.70f));
    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1, 1, 1, 1));
    const bool pressed = ImGui::Button(label, size);
    ImGui::PopStyleColor(4);
    return pressed;
}

bool ghostButton(const char* label, const ImVec2& size = ImVec2(0, 0)) {
    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0, 0, 0, 0));
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, kPanelRaised);
    ImGui::PushStyleColor(ImGuiCol_Text, kTextMuted);
    const bool pressed = ImGui::Button(label, size);
    ImGui::PopStyleColor(3);
    return pressed;
}

/// One-line description of what a tool call is doing, from its input.
std::string toolSummary(const ToolCall& tool) {
    const json& input = tool.input;
    const auto str = [&](const char* key) -> std::string {
        return input.is_object() && input.contains(key) && input[key].is_string()
                   ? input[key].get<std::string>()
                   : std::string();
    };

    if (tool.toolName == "bash") return str("command");
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

/// Compact, readable rendering of a tool result. The raw JSON is available on
/// expand; this is the line the user actually reads.
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
        if (!body.empty()) summary += "  " + splitLines(body).front();
        return summary;
    }
    if (output.contains("bytesWritten")) {
        return humanBytes(output.value("bytesWritten", 0LL)) + " written";
    }
    if (output.value("success", false)) return "done";
    return output.dump();
}

} // namespace

void App::render() {
    const ImGuiViewport* viewport = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(viewport->WorkPos);
    ImGui::SetNextWindowSize(viewport->WorkSize);

    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0, 0));
    ImGui::PushStyleColor(ImGuiCol_WindowBg, kBackground);
    ImGui::Begin("##root", nullptr,
                 ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove |
                     ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoScrollbar |
                     ImGuiWindowFlags_NoScrollWithMouse | ImGuiWindowFlags_NoBringToFrontOnFocus |
                     ImGuiWindowFlags_NoNavFocus);
    ImGui::PopStyleColor();
    ImGui::PopStyleVar();

    drawSidebar(kSidebarWidth);
    ImGui::SameLine(0.0f, 0.0f);
    drawMainColumn();

    ImGui::End();

    drawPermissionModal();
    if (showSettings_) drawSettingsWindow();
    drawToast();
}

void App::drawSidebar(float width) {
    ImGui::PushStyleColor(ImGuiCol_ChildBg, kPanel);
    ImGui::BeginChild("##sidebar", ImVec2(width, 0), ImGuiChildFlags_AlwaysUseWindowPadding,
                      ImGuiWindowFlags_NoScrollbar);

    if (fonts_.heading) ImGui::PushFont(fonts_.heading);
    ImGui::TextUnformatted("DarkCode");
    if (fonts_.heading) ImGui::PopFont();
    textMuted("desktop");

    verticalSpace(12.0f);

    bool streaming = false;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        streaming = streaming_;
    }

    ImGui::BeginDisabled(streaming);
    if (accentButton("New session", ImVec2(-FLT_MIN, 0))) startNewSession();
    ImGui::EndDisabled();

    verticalSpace(10.0f);

    const float footerHeight = ImGui::GetFrameHeightWithSpacing() * 2.0f + 28.0f;
    ImGui::PushStyleColor(ImGuiCol_ChildBg, ImVec4(0, 0, 0, 0));
    ImGui::BeginChild("##sessionList", ImVec2(0, -footerHeight));

    std::vector<SessionSummary> sessions;
    bool loading = false;
    {
        std::lock_guard<std::mutex> lock(sessionsMutex_);
        sessions = sessions_;
        loading = sessionsLoading_;
    }

    if (sessions.empty()) {
        wrappedMuted(loading ? "Loading sessions..."
                             : (signedIn_ ? "No sessions yet. Send a message to start one."
                                          : "Sign in to see your sessions."));
    }

    // Rows are drawn by hand rather than with Selectable: two lines of text at
    // different sizes need one shared hit box, and moving the layout cursor
    // around a Selectable fights the child window's scrolling.
    const float rowPaddingX = 10.0f;
    const float rowHeight = ImGui::GetTextLineHeight() * 2.0f + 14.0f;
    const float rowWidth = ImGui::GetContentRegionAvail().x;

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
        if (selected || hovered) {
            draw->AddRectFilled(origin, corner,
                                ImGui::GetColorU32(selected ? withAlpha(kAccent, 0.18f) : kPanelRaised),
                                8.0f);
        }
        if (selected) {
            draw->AddRectFilled(origin, ImVec2(origin.x + 3.0f, corner.y), ImGui::GetColorU32(kAccent),
                                2.0f);
        }

        draw->PushClipRect(ImVec2(origin.x + rowPaddingX, origin.y),
                           ImVec2(corner.x - rowPaddingX, corner.y), true);
        draw->AddText(ImVec2(origin.x + rowPaddingX + 4.0f, origin.y + 5.0f),
                      ImGui::GetColorU32(selected ? kText : kTextMuted), session.title.c_str());
        if (fonts_.caption) {
            draw->AddText(fonts_.caption, fonts_.caption->FontSize,
                          ImVec2(origin.x + rowPaddingX + 4.0f,
                                 origin.y + 5.0f + ImGui::GetTextLineHeight()),
                          ImGui::GetColorU32(kTextFaint), session.lastActivityAt.substr(0, 10).c_str());
        }
        draw->PopClipRect();

        ImGui::PopID();
    }

    ImGui::EndChild();
    ImGui::PopStyleColor();

    ImGui::Separator();
    verticalSpace(4.0f);

    const double credits = credits_.load();
    if (fonts_.caption) ImGui::PushFont(fonts_.caption);
    if (credits >= 0) {
        char buffer[64];
        std::snprintf(buffer, sizeof(buffer), "%.2f credits", credits);
        textMuted(buffer);
    } else {
        textMuted(signedIn_ ? "credits unavailable" : "signed out");
    }
    if (fonts_.caption) ImGui::PopFont();

    if (ghostButton("Settings", ImVec2(-FLT_MIN, 0))) showSettings_ = true;

    ImGui::EndChild();
    ImGui::PopStyleColor();
}

void App::drawMainColumn() {
    ImGui::PushStyleColor(ImGuiCol_ChildBg, kBackground);
    ImGui::BeginChild("##main", ImVec2(0, 0), ImGuiChildFlags_AlwaysUseWindowPadding,
                      ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);

    if (!signedIn_) {
        drawSignedOutState();
        ImGui::EndChild();
        ImGui::PopStyleColor();
        return;
    }

    // ---- header ----------------------------------------------------------
    if (fonts_.heading) ImGui::PushFont(fonts_.heading);
    ImGui::TextUnformatted(activeSessionId_.empty() ? "New session" : activeSessionTitle_.c_str());
    if (fonts_.heading) ImGui::PopFont();

    ImGui::SameLine();
    {
        const std::string modelLabel(modelDisplayName(settings_.model));
        const std::string right = modelLabel + "   " + settings_.mode;
        const float rightWidth = ImGui::CalcTextSize(right.c_str()).x;
        ImGui::SetCursorPosX(ImGui::GetCursorPosX() + ImGui::GetContentRegionAvail().x - rightWidth);
        if (fonts_.caption) ImGui::PushFont(fonts_.caption);
        textMuted(right);
        if (fonts_.caption) ImGui::PopFont();
    }

    verticalSpace(6.0f);

    // ---- transcript ------------------------------------------------------
    const float composerHeight = ImGui::GetTextLineHeight() * 4.2f + ImGui::GetFrameHeightWithSpacing() +
                                 ImGui::GetStyle().ItemSpacing.y * 3.0f;
    const float statusHeight = ImGui::GetTextLineHeight() + ImGui::GetStyle().ItemSpacing.y * 2.0f;

    ImGui::PushStyleColor(ImGuiCol_ChildBg, ImVec4(0, 0, 0, 0));
    ImGui::BeginChild("##transcript", ImVec2(0, -(composerHeight + statusHeight)), ImGuiChildFlags_None);
    drawTranscript();
    ImGui::EndChild();
    ImGui::PopStyleColor();

    drawComposer();
    drawStatusBar();

    ImGui::EndChild();
    ImGui::PopStyleColor();
}

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

    for (size_t i = 0; i < snapshot.size(); ++i) {
        ImGui::PushID(static_cast<int>(i));
        drawMessage(snapshot[i]);
        ImGui::PopID();
        verticalSpace(10.0f);
    }

    if (streaming && !status.empty()) {
        ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
        ImGui::TextUnformatted(status.c_str());
        ImGui::PopStyleColor();
    }

    if (scrollToBottom_.exchange(false)) ImGui::SetScrollHereY(1.0f);
}

void App::drawMessage(const Message& message) {
    const bool isUser = message.role == "user";

    ImGui::PushStyleColor(ImGuiCol_ChildBg, isUser ? kPanelRaised : ImVec4(0, 0, 0, 0));
    ImGui::BeginChild("##message", ImVec2(0, 0),
                      ImGuiChildFlags_AutoResizeY | ImGuiChildFlags_AlwaysUseWindowPadding);

    if (fonts_.caption) ImGui::PushFont(fonts_.caption);
    ImGui::PushStyleColor(ImGuiCol_Text, isUser ? kTextMuted : kAccent);
    ImGui::TextUnformatted(isUser ? "You" : "DarkCode");
    ImGui::PopStyleColor();
    if (fonts_.caption) ImGui::PopFont();

    verticalSpace(2.0f);

    if (message.metadata.compactionDropped > 0 && !isUser) {
        if (fonts_.caption) ImGui::PushFont(fonts_.caption);
        ImGui::PushStyleColor(ImGuiCol_Text, kWarning);
        ImGui::Text("Context compacted - %d earlier messages summarised",
                    message.metadata.compactionDropped);
        ImGui::PopStyleColor();
        if (fonts_.caption) ImGui::PopFont();
        verticalSpace(4.0f);
    }

    for (const Part& part : message.parts) {
        switch (part.kind) {
            case PartKind::Text:
                if (!part.text.empty()) drawMarkdown(part.text);
                break;
            case PartKind::Reasoning:
                if (!part.text.empty()) {
                    ImGui::PushStyleColor(ImGuiCol_Text, kTextFaint);
                    ImGui::TextWrapped("%s", part.text.c_str());
                    ImGui::PopStyleColor();
                }
                break;
            case PartKind::Tool:
                drawToolCall(part.tool);
                break;
        }
    }

    if (!message.errorText.empty()) {
        verticalSpace(4.0f);
        ImGui::PushStyleColor(ImGuiCol_Text, kDanger);
        ImGui::TextWrapped("%s", message.errorText.c_str());
        ImGui::PopStyleColor();
    }

    // Footer: what the turn cost and how full the window is.
    const TurnMetadata& meta = message.metadata;
    if (!isUser && !message.streaming && (meta.hasUsage || meta.durationMs > 0)) {
        verticalSpace(4.0f);
        std::string footer;
        if (meta.durationMs > 0) footer += formatDuration(meta.durationMs);
        if (meta.hasUsage) {
            if (!footer.empty()) footer += "  ";
            footer += humanCount(meta.inputTokens) + " in / " + humanCount(meta.outputTokens) + " out";
        }
        if (meta.contextWindow > 0) {
            const int percent =
                static_cast<int>(100.0 * static_cast<double>(meta.contextEstimatedTokens) /
                                 static_cast<double>(meta.contextWindow));
            footer += "  ctx " + std::to_string(percent) + "%";
        }
        if (fonts_.caption) ImGui::PushFont(fonts_.caption);
        ImGui::PushStyleColor(ImGuiCol_Text, kTextFaint);
        ImGui::TextUnformatted(footer.c_str());
        ImGui::PopStyleColor();
        if (fonts_.caption) ImGui::PopFont();
    }

    ImGui::EndChild();
    ImGui::PopStyleColor();
}

void App::drawToolCall(const ToolCall& tool) {
    ImVec4 color = kTextMuted;
    switch (tool.state) {
        case ToolState::OutputAvailable: color = kSuccess; break;
        case ToolState::OutputError: color = kDanger; break;
        case ToolState::InputAvailable: color = kWarning; break;
        case ToolState::InputStreaming: color = kTextFaint; break;
    }

    verticalSpace(4.0f);
    ImGui::PushID(tool.toolCallId.c_str());
    ImGui::PushStyleColor(ImGuiCol_ChildBg, kPanel);
    ImGui::BeginChild("##tool", ImVec2(0, 0),
                      ImGuiChildFlags_AutoResizeY | ImGuiChildFlags_AlwaysUseWindowPadding |
                          ImGuiChildFlags_Borders);

    statusDot(color);
    ImGui::TextUnformatted(tool.toolName.c_str());
    ImGui::SameLine(0.0f, 10.0f);

    const bool expanded = expandedTools_.count(tool.toolCallId) > 0;
    if (fonts_.mono) ImGui::PushFont(fonts_.mono);
    ImGui::PushStyleColor(ImGuiCol_Text, kTextMuted);
    const std::string summary = splitLines(toolSummary(tool)).front();
    ImGui::TextUnformatted(summary.substr(0, 110).c_str());
    ImGui::PopStyleColor();
    if (fonts_.mono) ImGui::PopFont();

    ImGui::SameLine();
    const char* toggle = expanded ? "hide" : "details";
    const float toggleWidth = ImGui::CalcTextSize(toggle).x + ImGui::GetStyle().FramePadding.x * 2.0f;
    ImGui::SetCursorPosX(ImGui::GetCursorPosX() + ImGui::GetContentRegionAvail().x - toggleWidth);
    if (ghostButton(toggle)) {
        if (expanded) expandedTools_.erase(tool.toolCallId);
        else expandedTools_.insert(tool.toolCallId);
    }

    if (tool.state == ToolState::OutputAvailable || tool.state == ToolState::OutputError) {
        if (fonts_.caption) ImGui::PushFont(fonts_.caption);
        ImGui::PushStyleColor(ImGuiCol_Text, tool.state == ToolState::OutputError ? kDanger : kTextFaint);
        ImGui::TextWrapped("%s", splitLines(toolResultPreview(tool)).front().substr(0, 300).c_str());
        ImGui::PopStyleColor();
        if (fonts_.caption) ImGui::PopFont();
    }

    if (expanded) {
        ImGui::Separator();
        textMuted("input");
        if (fonts_.mono) ImGui::PushFont(fonts_.mono);
        ImGui::TextWrapped("%s", tool.input.dump(2).c_str());
        if (fonts_.mono) ImGui::PopFont();

        if (tool.state == ToolState::OutputAvailable) {
            textMuted("output");
            if (fonts_.mono) ImGui::PushFont(fonts_.mono);
            ImGui::TextWrapped("%s", truncateForModel(tool.output.dump(2), 4000).c_str());
            if (fonts_.mono) ImGui::PopFont();
        } else if (tool.state == ToolState::OutputError) {
            ImGui::PushStyleColor(ImGuiCol_Text, kDanger);
            ImGui::TextWrapped("%s", tool.errorText.c_str());
            ImGui::PopStyleColor();
        }
    }

    ImGui::EndChild();
    ImGui::PopStyleColor();
    ImGui::PopID();
}

void App::drawMarkdown(const std::string& text) {
    size_t position = 0;
    int blockIndex = 0;

    const auto drawProse = [](const std::string& chunk) {
        const std::string trimmed = trim(chunk);
        if (!trimmed.empty()) ImGui::TextWrapped("%s", trimmed.c_str());
    };

    while (position < text.size()) {
        const size_t fence = text.find("```", position);
        if (fence == std::string::npos) {
            drawProse(text.substr(position));
            break;
        }
        if (fence > position) drawProse(text.substr(position, fence - position));

        const size_t headerEnd = text.find('\n', fence);
        if (headerEnd == std::string::npos) {
            drawProse(text.substr(fence));
            break;
        }
        const std::string language = trim(text.substr(fence + 3, headerEnd - fence - 3));
        const size_t close = text.find("```", headerEnd + 1);
        const std::string code =
            text.substr(headerEnd + 1, (close == std::string::npos ? text.size() : close) - headerEnd - 1);

        ImGui::PushID(blockIndex++);
        verticalSpace(4.0f);
        ImGui::PushStyleColor(ImGuiCol_ChildBg, kBackground);
        ImGui::BeginChild("##code", ImVec2(0, 0),
                          ImGuiChildFlags_AutoResizeY | ImGuiChildFlags_AlwaysUseWindowPadding |
                              ImGuiChildFlags_Borders,
                          ImGuiWindowFlags_HorizontalScrollbar);

        if (fonts_.caption) ImGui::PushFont(fonts_.caption);
        textMuted(language.empty() ? "code" : language);
        if (fonts_.caption) ImGui::PopFont();
        ImGui::SameLine();
        const float copyWidth = ImGui::CalcTextSize("copy").x + ImGui::GetStyle().FramePadding.x * 2.0f;
        ImGui::SetCursorPosX(ImGui::GetCursorPosX() + ImGui::GetContentRegionAvail().x - copyWidth);
        if (ghostButton("copy")) ImGui::SetClipboardText(code.c_str());

        if (fonts_.mono) ImGui::PushFont(fonts_.mono);
        ImGui::TextUnformatted(code.c_str());
        if (fonts_.mono) ImGui::PopFont();

        ImGui::EndChild();
        ImGui::PopStyleColor();
        verticalSpace(4.0f);
        ImGui::PopID();

        if (close == std::string::npos) break;
        position = close + 3;
    }
}

void App::drawComposer() {
    bool streaming = false;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        streaming = streaming_;
    }

    if (focusComposer_ && !ImGui::IsAnyItemActive()) {
        ImGui::SetKeyboardFocusHere();
        focusComposer_ = false;
    }

    ImGui::PushStyleColor(ImGuiCol_FrameBg, kPanel);
    const bool submitted = ImGui::InputTextMultiline(
        "##composer", composerBuffer_.data(), composerBuffer_.size(),
        ImVec2(-FLT_MIN, ImGui::GetTextLineHeight() * 3.6f),
        ImGuiInputTextFlags_EnterReturnsTrue | ImGuiInputTextFlags_CtrlEnterForNewLine);
    ImGui::PopStyleColor();

    // ---- controls row ----------------------------------------------------
    const bool planMode = settings_.mode == "PLAN";
    ImGui::BeginDisabled(streaming);
    // Stable widget id: without the "##mode" suffix the label *is* the id, so
    // toggling the mode would change the id and shuffle keyboard focus.
    if (ImGui::Button(planMode ? "PLAN##mode" : "BUILD##mode", ImVec2(84, 0))) {
        settings_.mode = planMode ? "BUILD" : "PLAN";
        settings_.save();
    }
    ImGui::EndDisabled();
    if (ImGui::IsItemHovered()) {
        ImGui::SetTooltip(planMode ? "PLAN: read-only tools. Click for BUILD."
                                   : "BUILD: writes and shell enabled. Click for PLAN.");
    }

    ImGui::SameLine();
    ImGui::SetNextItemWidth(220.0f);
    ImGui::BeginDisabled(streaming);
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

    ImGui::SameLine();
    if (fonts_.caption) ImGui::PushFont(fonts_.caption);
    textMuted("Enter to send - Ctrl+Enter for a new line");
    if (fonts_.caption) ImGui::PopFont();

    ImGui::SameLine();
    const char* actionLabel = streaming ? "Stop" : "Send";
    const float actionWidth = 96.0f;
    ImGui::SetCursorPosX(ImGui::GetCursorPosX() + ImGui::GetContentRegionAvail().x - actionWidth);

    bool send = false;
    if (streaming) {
        ImGui::PushStyleColor(ImGuiCol_Button, kDanger);
        ImGui::PushStyleColor(ImGuiCol_ButtonHovered, withAlpha(kDanger, 0.85f));
        ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1, 1, 1, 1));
        if (ImGui::Button(actionLabel, ImVec2(actionWidth, 0))) stopTurn();
        ImGui::PopStyleColor(3);
    } else {
        send = accentButton(actionLabel, ImVec2(actionWidth, 0));
    }

    if ((submitted || send) && !streaming) {
        const std::string text(composerBuffer_.data());
        if (!trim(text).empty()) {
            submit(text);
            composerBuffer_.assign(composerBuffer_.size(), '\0');
        }
        focusComposer_ = true;
    }
}

void App::drawStatusBar() {
    if (fonts_.caption) ImGui::PushFont(fonts_.caption);
    ImGui::PushStyleColor(ImGuiCol_Text, kTextFaint);

    std::string line = settings_.apiUrl + "   " + settings_.projectDir;
    if (settings_.autoApproveWrites) line += "   writes auto-approved";
    if (settings_.autoApproveBash) line += "   shell auto-approved";
    ImGui::TextUnformatted(line.c_str());

    ImGui::PopStyleColor();
    if (fonts_.caption) ImGui::PopFont();
}

void App::drawEmptyState() {
    verticalSpace(ImGui::GetContentRegionAvail().y * 0.28f);
    if (fonts_.heading) ImGui::PushFont(fonts_.heading);
    ImGui::PushStyleColor(ImGuiCol_Text, kTextMuted);
    ImGui::TextUnformatted("What are we building?");
    ImGui::PopStyleColor();
    if (fonts_.heading) ImGui::PopFont();

    verticalSpace(6.0f);
    wrappedMuted("Tools run on this machine, against " + settings_.projectDir +
                 ". PLAN mode keeps them read-only; BUILD mode allows writes and shell commands.");
}

void App::drawSignedOutState() {
    verticalSpace(ImGui::GetContentRegionAvail().y * 0.25f);
    if (fonts_.heading) ImGui::PushFont(fonts_.heading);
    ImGui::TextUnformatted("Sign in to DarkCode");
    if (fonts_.heading) ImGui::PopFont();

    verticalSpace(8.0f);
    wrappedMuted("The desktop app reads the same credentials as the CLI. In a terminal, run "
                 "darkcode and use /login, then come back here.");
    verticalSpace(12.0f);

    if (accentButton("I have signed in")) {
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
    ImGui::SameLine();
    if (ghostButton("Settings")) showSettings_ = true;
}

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
    if (ImGui::BeginPopupModal("Permission required", nullptr,
                               ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove)) {
        if (fonts_.heading) ImGui::PushFont(fonts_.heading);
        ImGui::TextUnformatted(request.title.c_str());
        if (fonts_.heading) ImGui::PopFont();

        verticalSpace(6.0f);
        ImGui::PushStyleColor(ImGuiCol_ChildBg, kBackground);
        ImGui::BeginChild("##subject", ImVec2(0, 0),
                          ImGuiChildFlags_AutoResizeY | ImGuiChildFlags_AlwaysUseWindowPadding |
                              ImGuiChildFlags_Borders);
        if (fonts_.mono) ImGui::PushFont(fonts_.mono);
        ImGui::TextWrapped("%s", request.subject.c_str());
        if (fonts_.mono) ImGui::PopFont();
        ImGui::EndChild();
        ImGui::PopStyleColor();

        if (!request.detail.empty()) {
            verticalSpace(6.0f);
            textMuted(request.kind == PermissionKind::Bash ? "context" : "new contents (preview)");
            ImGui::PushStyleColor(ImGuiCol_ChildBg, kBackground);
            ImGui::BeginChild("##detail", ImVec2(0, 180),
                              ImGuiChildFlags_AlwaysUseWindowPadding | ImGuiChildFlags_Borders,
                              ImGuiWindowFlags_HorizontalScrollbar);
            if (fonts_.mono) ImGui::PushFont(fonts_.mono);
            ImGui::TextUnformatted(truncateForModel(request.detail, 8000).c_str());
            if (fonts_.mono) ImGui::PopFont();
            ImGui::EndChild();
            ImGui::PopStyleColor();
        }

        verticalSpace(10.0f);
        ImGui::BeginDisabled(!armed);

        if (accentButton("Allow once", ImVec2(140, 0)) && armed) {
            permissions_.resolve(PermissionDecision::AllowOnce);
            ImGui::CloseCurrentPopup();
        }
        ImGui::SameLine();
        if (ImGui::Button(request.sessionLabel.c_str()) && armed) {
            permissions_.resolve(PermissionDecision::AllowSession);
            ImGui::CloseCurrentPopup();
        }
        ImGui::SameLine();
        const float denyWidth = 100.0f;
        ImGui::SetCursorPosX(ImGui::GetCursorPosX() + ImGui::GetContentRegionAvail().x - denyWidth);
        const bool denied = ImGui::Button("Deny", ImVec2(denyWidth, 0));
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
}

void App::drawSettingsWindow() {
    ImGui::SetNextWindowSize(ImVec2(640, 620), ImGuiCond_FirstUseEver);
    ImGui::SetNextWindowPos(ImGui::GetMainViewport()->GetCenter(), ImGuiCond_FirstUseEver,
                            ImVec2(0.5f, 0.5f));
    ImGui::PushStyleColor(ImGuiCol_WindowBg, kPanel);
    if (ImGui::Begin("Settings", &showSettings_, ImGuiWindowFlags_NoCollapse)) {
        ImGui::SeparatorText("Connection");
        ImGui::TextUnformatted("API URL");
        ImGui::SetNextItemWidth(-FLT_MIN);
        ImGui::InputText("##apiUrl", apiUrlBuffer_.data(), apiUrlBuffer_.size());
        if (settings_.apiUrlFromEnv) {
            if (fonts_.caption) ImGui::PushFont(fonts_.caption);
            ImGui::PushStyleColor(ImGuiCol_Text, kWarning);
            ImGui::TextWrapped("DARKCODE_API_URL is set, so this session talks to %s. The value above "
                               "is what will be used once that variable is gone.",
                               settings_.apiUrl.c_str());
            ImGui::PopStyleColor();
            if (fonts_.caption) ImGui::PopFont();
        }

        ImGui::TextUnformatted("Project directory (tools resolve paths against this)");
        const float browseWidth = 110.0f;
        ImGui::SetNextItemWidth(ImGui::GetContentRegionAvail().x - browseWidth -
                                ImGui::GetStyle().ItemSpacing.x);
        ImGui::InputText("##projectDir", projectDirBuffer_.data(), projectDirBuffer_.size());
        ImGui::SameLine();
        if (ImGui::Button("Browse...", ImVec2(browseWidth, 0))) {
            const std::string chosen = browseForFolder(trim(projectDirBuffer_.data()));
            if (!chosen.empty()) {
                std::snprintf(projectDirBuffer_.data(), projectDirBuffer_.size(), "%s", chosen.c_str());
            }
        }

        if (findBashPath().empty()) {
            ImGui::PushStyleColor(ImGuiCol_Text, kWarning);
            ImGui::TextWrapped("bash was not found. The shell tool needs Git for Windows installed.");
            ImGui::PopStyleColor();
        }

        ImGui::SeparatorText("Permissions");
        ImGui::Checkbox("Auto-approve file reads", &settings_.autoApproveReads);
        ImGui::Checkbox("Auto-approve file writes", &settings_.autoApproveWrites);
        ImGui::Checkbox("Auto-approve shell commands", &settings_.autoApproveBash);
        if (fonts_.caption) ImGui::PushFont(fonts_.caption);
        wrappedMuted("Secrets (.env, keys, ~/.ssh, credential stores) are refused whatever these say. "
                     "Destructive shell commands are refused too.");
        if (fonts_.caption) ImGui::PopFont();

        ImGui::SeparatorText("Context");
        ImGui::Checkbox("Send project context (git branch, AGENTS.md / CLAUDE.md)",
                        &settings_.sendProjectContext);

        ImGui::SeparatorText("API keys (BYOK)");
        if (fonts_.caption) ImGui::PushFont(fonts_.caption);
        wrappedMuted("Stored in ~/.darkcode/api-keys.json, shared with the CLI. A key of your own is "
                     "never metered as credits.");
        if (fonts_.caption) ImGui::PopFont();

        for (size_t i = 0; i < kByokProviders.size(); ++i) {
            ImGui::PushID(static_cast<int>(i));
            ImGui::TextUnformatted(std::string(kByokProviders[i].label).c_str());
            ImGui::SetNextItemWidth(-FLT_MIN);
            ImGui::InputTextWithHint("##key", std::string(kByokProviders[i].placeholder).c_str(),
                                     apiKeyBuffers_[i].data(), apiKeyBuffers_[i].size(),
                                     ImGuiInputTextFlags_Password);
            ImGui::PopID();
        }

        ImGui::SeparatorText("Account");
        if (ImGui::Button("Reload credentials from disk")) {
            api_.reloadAuthFromDisk();
            signedIn_ = api_.signedIn();
            if (signedIn_) {
                refreshSessions();
                refreshCredits();
            }
        }
        ImGui::SameLine();
        if (ImGui::Button("Sign out")) {
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

        verticalSpace(12.0f);
        if (accentButton("Save", ImVec2(120, 0))) {
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
        ImGui::SameLine();
        if (ghostButton("Close", ImVec2(120, 0))) showSettings_ = false;
    }
    ImGui::End();
    ImGui::PopStyleColor();
}

void App::drawToast() {
    if (toastText_.empty()) return;

    const ImGuiViewport* viewport = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(ImVec2(viewport->WorkPos.x + viewport->WorkSize.x - 24.0f,
                                   viewport->WorkPos.y + viewport->WorkSize.y - 24.0f),
                            ImGuiCond_Always, ImVec2(1.0f, 1.0f));
    ImGui::SetNextWindowBgAlpha(0.96f);
    ImGui::PushStyleColor(ImGuiCol_WindowBg, toastIsError_ ? ImVec4(0.24f, 0.08f, 0.09f, 1.0f) : kPanelRaised);
    ImGui::Begin("##toast", nullptr,
                 ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove |
                     ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoSavedSettings |
                     ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoNav);
    ImGui::PushTextWrapPos(460.0f);
    ImGui::PushStyleColor(ImGuiCol_Text, toastIsError_ ? kDanger : kText);
    ImGui::TextWrapped("%s", toastText_.c_str());
    ImGui::PopStyleColor();
    ImGui::PopTextWrapPos();
    ImGui::End();
    ImGui::PopStyleColor();
}

} // namespace dc
