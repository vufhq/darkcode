// Application state and the turn loop.
//
// Threading rules, kept deliberately narrow:
//   * `activeSessionId_`, `settings_` and every UI-only field are written on
//     the UI thread only. Workers hand results back through the `pending*`
//     slots, which `tick()` applies.
//   * `messages_`, `streaming_` and the status strings are shared, guarded by
//     `stateMutex_`.
//   * A turn snapshots the settings it needs, so changing the model mid-stream
//     cannot alter the request already in flight.
#pragma once

#include <atomic>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "api.h"
#include "chat.h"
#include "config.h"
#include "permissions.h"
#include "theme.h"
#include "tools.h"

namespace dc {

class App {
public:
    App();
    ~App();

    App(const App&) = delete;
    App& operator=(const App&) = delete;

    void setFonts(const theme::Fonts& fonts) { fonts_ = fonts; }

    /// Applies anything workers handed back. Runs once per frame, UI thread.
    void tick();
    /// Draws the whole UI into the current viewport.
    void render();

private:
    // ---- actions ---------------------------------------------------------
    void refreshSessions();
    void activateSession(const SessionSummary& session);
    void loadSessionMessages(const std::string& id);
    void startNewSession();
    void refreshCredits();
    void submit(const std::string& text);
    void stopTurn();
    void runTurn();
    void joinTurnThread();

    /// Runs each pending tool in order, publishing every result into
    /// `messages_[assistantIndex]` as it lands so the UI shows progress.
    void resolvePendingToolCalls(Message& message, size_t assistantIndex);
    json buildRequestBody(const Message& userMessage, const Message* assistantMessage) const;

    void toast(const std::string& text, bool isError = false);

    // ---- drawing ---------------------------------------------------------
    void drawSidebar(float width);
    void drawMainColumn();
    void drawTranscript();
    void drawComposer();
    void drawStatusBar();
    void drawMessage(const Message& message);
    void drawToolCall(const ToolCall& tool);
    void drawMarkdown(const std::string& text);
    void drawEmptyState();
    void drawSignedOutState();
    void drawPermissionModal();
    void drawSettingsWindow();
    void drawToast();

    // ---- shared state ----------------------------------------------------
    Settings settings_;
    Api api_;
    PermissionBroker permissions_;
    TodoStore todos_;
    theme::Fonts fonts_;

    mutable std::mutex stateMutex_;
    std::vector<Message> messages_;
    bool streaming_ = false;
    std::string streamStatus_;

    std::mutex sessionsMutex_;
    std::vector<SessionSummary> sessions_;
    bool sessionsLoading_ = false;

    /// Handed over by workers, applied by tick() on the UI thread.
    std::mutex pendingMutex_;
    std::optional<SessionSummary> pendingActivate_;
    std::string pendingSubmit_;
    std::string pendingToast_;
    bool pendingToastIsError_ = false;

    // ---- UI-thread-owned -------------------------------------------------
    std::string activeSessionId_;
    std::string activeSessionTitle_;

    /// Snapshot taken when a turn starts; the worker reads only these.
    std::string turnSessionId_;
    std::string turnMode_;
    std::string turnModel_;
    std::string turnProjectDir_;
    bool turnSendProjectContext_ = true;

    std::atomic<bool> sessionLoading_{false};
    std::atomic<bool> cancelTurn_{false};
    std::atomic<bool> scrollToBottom_{false};
    std::atomic<double> credits_{-1.0};
    std::atomic<bool> signedIn_{false};
    std::thread turnThread_;

    std::vector<char> composerBuffer_;
    bool focusComposer_ = true;
    bool showSettings_ = false;
    std::vector<char> apiUrlBuffer_;
    std::vector<char> projectDirBuffer_;
    std::vector<std::vector<char>> apiKeyBuffers_;
    std::set<std::string> expandedTools_; // keyed by toolCallId

    std::string toastText_;
    bool toastIsError_ = false;
    long long toastUntilMs_ = 0;
};

} // namespace dc
