#include "app.h"

#include <windows.h>

#include <algorithm>
#include <cstdio>

#include "models.h"
#include "util.h"

namespace dc {
namespace {

// Ceiling on tool round-trips inside one turn. The AI SDK client has an
// equivalent guard; without one, a model that keeps calling tools would loop
// against the API indefinitely.
constexpr int kMaxStepsPerTurn = 32;

std::string defaultSessionTitle() {
    SYSTEMTIME st{};
    ::GetLocalTime(&st);
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "Session %04d-%02d-%02d %02d:%02d", st.wYear, st.wMonth,
                  st.wDay, st.wHour, st.wMinute);
    return buffer;
}

/// Names a session after its opening prompt rather than "Untitled".
std::string titleFromPrompt(const std::string& text) {
    const std::vector<std::string> lines = splitLines(text);
    std::string title = lines.empty() ? std::string() : trim(lines.front());
    if (title.empty()) return defaultSessionTitle();
    if (title.size() > 60) title = title.substr(0, 57) + "...";
    return title;
}

} // namespace

App::App() : api_(settings_) {
    settings_.load();
    api_.setOrigin(settings_.apiUrl, false);
    signedIn_ = api_.signedIn();

    composerBuffer_.assign(16 * 1024, '\0');
    apiUrlBuffer_.assign(512, '\0');
    projectDirBuffer_.assign(1024, '\0');
    std::snprintf(apiUrlBuffer_.data(), apiUrlBuffer_.size(), "%s", settings_.apiUrlStored.c_str());
    std::snprintf(projectDirBuffer_.data(), projectDirBuffer_.size(), "%s", settings_.projectDir.c_str());

    apiKeyBuffers_.resize(kByokProviders.size());
    const auto storedKeys = loadApiKeys();
    for (size_t i = 0; i < kByokProviders.size(); ++i) {
        apiKeyBuffers_[i].assign(512, '\0');
        const auto it = storedKeys.find(std::string(kByokProviders[i].id));
        if (it != storedKeys.end()) {
            std::snprintf(apiKeyBuffers_[i].data(), apiKeyBuffers_[i].size(), "%s", it->second.c_str());
        }
    }

    if (signedIn_) {
        refreshSessions();
        refreshCredits();
    }
}

App::~App() {
    cancelTurn_ = true;
    cancelSignIn_ = true;
    api_.chatGpt().shutdown();
    permissions_.cancelAll();
    joinTurnThread();
    joinBackgroundThreads();
    settings_.save();
}

void App::joinTurnThread() {
    if (turnThread_.joinable()) turnThread_.join();
    turnFinished_ = true;
}

void App::joinBackgroundThreads() {
    if (compactThread_.joinable()) compactThread_.join();
    if (authThread_.joinable()) authThread_.join();
    joinAccountThreads();
    if (signOutThread_.joinable()) signOutThread_.join();
}

void App::joinAccountThreads() {
    if (sessionsThread_.joinable()) sessionsThread_.join();
    if (creditsThread_.joinable()) creditsThread_.join();
    if (sessionLoadThread_.joinable()) sessionLoadThread_.join();
    if (sessionCreateThread_.joinable()) sessionCreateThread_.join();
    sessionsLoading_ = false;
    creditsLoading_ = false;
    sessionLoading_ = false;
    sessionCreating_ = false;
}

void App::startSignIn() {
    if (signingIn_.exchange(true)) return;
    if (authThread_.joinable()) authThread_.join();
    cancelSignIn_ = false;
    {
        std::lock_guard<std::mutex> lock(authStateMutex_);
        signInError_.clear();
        signInStatus_ = "Preparing secure sign-in...";
    }

    const std::string apiUrl = settings_.apiUrl;
    const unsigned long long generation = accountGeneration_.load();
    authThread_ = std::thread([this, apiUrl, generation] {
        OAuthResult result = signInWithBrowser(apiUrl, cancelSignIn_, [this](const std::string& status) {
            std::lock_guard<std::mutex> lock(authStateMutex_);
            signInStatus_ = status;
        });

        std::lock_guard<std::mutex> lock(pendingMutex_);
        pendingSignInComplete_ = result.ok();
        pendingSignInError_ = result.error;
        pendingSignInAuth_ = result.ok() ? std::optional<AuthData>(std::move(result.auth)) : std::nullopt;
        pendingSignInGeneration_ = generation;
        pendingSignInOrigin_ = apiUrl;
    });
}

void App::cancelSignIn() {
    cancelSignIn_ = true;
    std::lock_guard<std::mutex> lock(authStateMutex_);
    signInStatus_ = "Cancelling sign-in...";
}

void App::startSignOut() {
    if (signOutLoading_.exchange(true)) return;
    const SignOutContext context = api_.prepareSignOut();
    clearAccountState();
    if (signOutThread_.joinable()) signOutThread_.join();
    signOutThread_ = std::thread([this, context] {
        api_.revokeAccessToken(context);
        signOutLoading_ = false;
        toast("Signed out.");
    });
}

void App::clearAccountState() {
    accountGeneration_.fetch_add(1);
    cancelTurn_ = true;
    permissions_.cancelAll();

    signedIn_ = false;
    credits_ = -1.0;
    refreshSessionsWhenIdle_ = false;
    refreshCreditsWhenIdle_ = false;
    activeSessionId_.clear();
    activeSessionTitle_.clear();
    todos_.clear();
    permissions_.resetSessionGrants();
    expandedTools_.clear();
    toolDetailHeights_.clear();
    std::fill(composerBuffer_.begin(), composerBuffer_.end(), '\0');
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        messages_.clear();
        streaming_ = false;
        streamStatus_.clear();
    }
    {
        std::lock_guard<std::mutex> lock(sessionsMutex_);
        sessions_.clear();
    }
    {
        std::lock_guard<std::mutex> lock(pendingMutex_);
        pendingActivate_.reset();
        pendingSubmit_.clear();
    }
}

void App::toast(const std::string& text, bool isError) {
    std::lock_guard<std::mutex> lock(pendingMutex_);
    pendingToast_ = text;
    pendingToastIsError_ = isError;
}

void App::compactSession() {
    if (activeSessionId_.empty() || !signedIn_ || compacting_) return;
    {
        std::lock_guard lock(stateMutex_);
        if (streaming_) return;
    }
    if (settings_.model == kChatGptModel && !api_.chatGpt().status().available) {
        settingsTab_ = 2; showSettings_ = true;
        toast("Connect ChatGPT before compacting context. No fallback is used.", true);
        return;
    }
    if (compactThread_.joinable()) compactThread_.join();
    compacting_ = true;
    const auto id = activeSessionId_;
    const auto model = settings_.model;
    const auto generation = accountGeneration_.load();
    compactThread_ = std::thread([this, id, model, generation] {
        std::string error;
        const bool ok = api_.compactSession(id, model, error);
        if (generation == accountGeneration_) toast(ok ? "Context compaction finished." : error, !ok);
        compacting_ = false;
    });
}

void App::tick() {
    if (turnFinished_ && turnThread_.joinable()) joinTurnThread();

    std::optional<SessionSummary> activate;
    std::string submitText;
    std::string toastText;
    bool toastIsError = false;
    bool signInComplete = false;
    std::string signInError;
    std::optional<AuthData> signInAuth;
    unsigned long long signInGeneration = 0;
    std::string signInOrigin;
    {
        std::lock_guard<std::mutex> lock(pendingMutex_);
        activate.swap(pendingActivate_);
        submitText.swap(pendingSubmit_);
        toastText.swap(pendingToast_);
        toastIsError = pendingToastIsError_;
        signInComplete = pendingSignInComplete_;
        pendingSignInComplete_ = false;
        signInError.swap(pendingSignInError_);
        signInAuth.swap(pendingSignInAuth_);
        signInGeneration = pendingSignInGeneration_;
        signInOrigin.swap(pendingSignInOrigin_);
    }

    if (activate) activateSession(*activate);
    if (!toastText.empty()) {
        toastText_ = toastText;
        toastIsError_ = toastIsError;
        toastUntilMs_ = nowMs() + (toastIsError ? 8000 : 4000);
    }
    if (!toastText_.empty() && nowMs() > toastUntilMs_) toastText_.clear();

    if (signInComplete || !signInError.empty()) {
        signingIn_ = false;
        if (authThread_.joinable()) authThread_.join();
        std::lock_guard<std::mutex> lock(authStateMutex_);
        const bool stillCurrent = signInComplete && signInAuth.has_value() &&
                                  signInGeneration == accountGeneration_.load() &&
                                  signInOrigin == api_.origin() && !cancelSignIn_;
        if (stillCurrent) {
            api_.setAuth(*signInAuth);
            signInError_.clear();
            signInStatus_.clear();
            signedIn_ = true;
            accountGeneration_.fetch_add(1);
            refreshSessionsWhenIdle_ = true;
            refreshCreditsWhenIdle_ = true;
            toast("Signed in.");
        } else {
            signInStatus_.clear();
            signInError_ = signInError.empty() ? "Sign-in was cancelled before it completed." : signInError;
        }
    }

    if (signedIn_ && !signOutLoading_ && !api_.signedIn()) {
        clearAccountState();
        std::lock_guard<std::mutex> lock(authStateMutex_);
        signInError_ = "Your session expired. Sign in again to continue.";
    }

    if (signedIn_ && refreshSessionsWhenIdle_) {
        bool loading = false;
        {
            std::lock_guard<std::mutex> lock(sessionsMutex_);
            loading = sessionsLoading_;
        }
        if (!loading) {
            refreshSessionsWhenIdle_ = false;
            refreshSessions();
        }
    }
    if (signedIn_ && refreshCreditsWhenIdle_ && !creditsLoading_) {
        refreshCreditsWhenIdle_ = false;
        refreshCredits();
    }

    // A message typed before the session existed is sent once its id lands.
    if (!submitText.empty() && !activeSessionId_.empty()) submit(submitText);
}

void App::refreshSessions() {
    {
        std::lock_guard<std::mutex> lock(sessionsMutex_);
        if (sessionsLoading_) return;
        sessionsLoading_ = true;
    }

    if (sessionsThread_.joinable()) sessionsThread_.join();
    const unsigned long long generation = accountGeneration_.load();
    sessionsThread_ = std::thread([this, generation] {
        std::vector<SessionSummary> loaded;
        std::string error;
        const bool ok = api_.listSessions(loaded, error);

        {
            std::lock_guard<std::mutex> lock(sessionsMutex_);
            if (ok && generation == accountGeneration_.load()) sessions_ = std::move(loaded);
            sessionsLoading_ = false;
        }
        if (generation == accountGeneration_.load()) {
            signedIn_ = api_.signedIn();
            if (!ok) toast("Could not load sessions: " + error, true);
        }
    });
}

void App::refreshCredits() {
    if (creditsLoading_.exchange(true)) return;
    if (creditsThread_.joinable()) creditsThread_.join();
    const unsigned long long generation = accountGeneration_.load();
    creditsThread_ = std::thread([this, generation] {
        double balance = 0;
        std::string error;
        if (api_.getCreditBalance(balance, error) && generation == accountGeneration_.load()) {
            credits_ = balance;
        }
        creditsLoading_ = false;
    });
}

void App::activateSession(const SessionSummary& session) {
    activeSessionId_ = session.id;
    activeSessionTitle_ = session.title;
    todos_.clear();
    permissions_.resetSessionGrants();
    expandedTools_.clear();
    toolDetailHeights_.clear();
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        messages_.clear();
    }
    scrollToBottom_ = true;
    loadSessionMessages(session.id);
}

void App::loadSessionMessages(const std::string& id) {
    if (id.empty() || sessionLoading_) return;
    sessionLoading_ = true;

    if (sessionLoadThread_.joinable()) sessionLoadThread_.join();
    const unsigned long long generation = accountGeneration_.load();
    sessionLoadThread_ = std::thread([this, id, generation] {
        json rawMessages;
        std::string error;
        const bool ok = api_.getSessionMessages(id, rawMessages, error);

        std::vector<Message> loaded;
        if (ok) {
            for (const auto& raw : rawMessages) {
                Message message = Message::fromJson(raw);
                if (!message.parts.empty()) loaded.push_back(std::move(message));
            }
        }

        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            // A newly created session has no stored messages; never clobber a
            // transcript the user has already started typing into.
            if (ok && !loaded.empty() && generation == accountGeneration_.load()) {
                messages_ = std::move(loaded);
            }
        }
        sessionLoading_ = false;
        scrollToBottom_ = true;
        if (!ok && generation == accountGeneration_.load()) {
            toast("Could not open the session: " + error, true);
        }
    });
}

void App::startNewSession() {
    // Deliberately does not hit the API: the session is created with the first
    // message, so it can be named after the prompt and an abandoned draft never
    // leaves an empty session behind.
    activeSessionId_.clear();
    activeSessionTitle_.clear();
    todos_.clear();
    permissions_.resetSessionGrants();
    expandedTools_.clear();
    toolDetailHeights_.clear();
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        messages_.clear();
    }
    focusComposer_ = true;
}

json App::buildRequestBody(const Message& userMessage, const Message* assistantMessage) const {
    json body = json::object();
    body["id"] = turnSessionId_;
    body["mode"] = turnMode_;
    body["model"] = turnModel_;

    // The server merges incoming messages by id, so a tool round-trip re-sends
    // the same pair: the user turn plus the assistant message carrying results.
    json messages = json::array();
    messages.push_back(userMessage.toJson());
    if (assistantMessage) messages.push_back(assistantMessage->toJson());
    body["messages"] = std::move(messages);

    const json todos = todos_.list();
    if (!todos.empty()) body["todos"] = todos;

    if (turnSendProjectContext_) body["projectContext"] = collectProjectContext(turnProjectDir_);

    return body;
}

bool App::submit(const std::string& text) {
    const std::string trimmed = trim(text);
    if (trimmed.empty()) return false;
    if (compacting_) { toast("Wait for context compaction to finish.", true); return false; }
    if (settings_.model == kChatGptModel && !api_.chatGpt().status().available) {
        settingsTab_ = 2;
        showSettings_ = true;
        toast("Connect ChatGPT in Settings > Models. No hosted or API-key fallback is used.", true);
        return false;
    }

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (streaming_) return false;
    }

    if (turnThread_.joinable()) {
        if (!turnFinished_) {
            toast("The previous turn is still stopping. Try again shortly.", true);
            return false;
        }
        joinTurnThread();
    }

    if (activeSessionId_.empty()) {
        // First message of a new session: create it, then let tick() send the
        // text once the id exists.
        const std::string title = titleFromPrompt(trimmed);
        if (sessionCreating_.exchange(true)) return false;
        if (sessionCreateThread_.joinable()) sessionCreateThread_.join();
        const unsigned long long generation = accountGeneration_.load();
        sessionCreateThread_ = std::thread([this, title, trimmed, generation] {
            SessionSummary created;
            std::string error;
            if (!api_.createSession(title, created, error)) {
                sessionCreating_ = false;
                if (generation == accountGeneration_.load()) {
                    toast("Could not create the session: " + error, true);
                }
                return;
            }
            if (generation != accountGeneration_.load()) {
                sessionCreating_ = false;
                return;
            }
            {
                std::lock_guard<std::mutex> lock(sessionsMutex_);
                sessions_.insert(sessions_.begin(), created);
            }
            std::lock_guard<std::mutex> lock(pendingMutex_);
            pendingActivate_ = created;
            pendingSubmit_ = trimmed;
            sessionCreating_ = false;
        });
        return true;
    }

    Message user;
    user.id = "msg-" + randomId(20);
    user.role = "user";
    Part part;
    part.kind = PartKind::Text;
    part.text = trimmed;
    user.parts.push_back(std::move(part));
    user.metadata.mode = settings_.mode;
    user.metadata.model = settings_.model;

    cancelTurn_ = false;
    permissions_.clearCancel();

    // Snapshot everything the worker needs, so changing the model or mode
    // mid-stream cannot alter the request already in flight.
    turnSessionId_ = activeSessionId_;
    turnMode_ = settings_.mode;
    turnModel_ = settings_.model;
    turnProjectDir_ = settings_.projectDir;
    turnSendProjectContext_ = settings_.sendProjectContext;

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        messages_.push_back(std::move(user));
        streaming_ = true;
        streamStatus_ = "Thinking...";
    }
    scrollToBottom_ = true;

    const unsigned long long generation = accountGeneration_.load();
    turnFinished_ = false;
    turnThread_ = std::thread([this, generation] { runTurn(generation); });
    return true;
}

void App::stopTurn() {
    cancelTurn_ = true;
    permissions_.cancelAll();
    std::lock_guard<std::mutex> lock(stateMutex_);
    streamStatus_ = "Stopping...";
}

void App::runTurn(unsigned long long generation) {
    Message userMessage;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (generation != accountGeneration_.load() || messages_.empty()) {
            turnFinished_ = true;
            return;
        }
        userMessage = messages_.back();
    }

    Message assistant;
    assistant.role = "assistant";
    assistant.id = "msg-" + randomId(20);
    assistant.streaming = true;
    assistant.metadata.mode = turnMode_;
    assistant.metadata.model = turnModel_;

    size_t assistantIndex = 0;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (generation != accountGeneration_.load()) {
            turnFinished_ = true;
            return;
        }
        messages_.push_back(assistant);
        assistantIndex = messages_.size() - 1;
    }

    for (int step = 0; step < kMaxStepsPerTurn; ++step) {
        if (cancelTurn_ || generation != accountGeneration_.load()) break;

        const json body = buildRequestBody(userMessage, step == 0 ? nullptr : &assistant);

        SseDecoder decoder;
        const HttpResult result = api_.streamChat(
            body,
            [&, generation](const char* data, size_t length) {
                if (cancelTurn_ || generation != accountGeneration_.load()) return false;
                decoder.feed(data, length, [&](const std::string& payload) {
                    const json chunk = json::parse(payload, nullptr, false);
                    if (chunk.is_discarded()) return;

                    std::lock_guard<std::mutex> lock(stateMutex_);
                    if (generation != accountGeneration_.load() || assistantIndex >= messages_.size()) return;
                    applyChunk(messages_[assistantIndex], chunk);
                    streamStatus_ = "Responding...";
                });
                scrollToBottom_ = true;
                return generation == accountGeneration_.load();
            },
            [this] { return cancelTurn_.load(); });

        if (generation != accountGeneration_.load()) {
            turnFinished_ = true;
            return;
        }

        if (cancelTurn_ || result.aborted) {
            std::lock_guard<std::mutex> lock(stateMutex_);
            if (generation != accountGeneration_.load() || assistantIndex >= messages_.size()) {
                turnFinished_ = true;
                return;
            }
            if (messages_[assistantIndex].errorText.empty()) {
                messages_[assistantIndex].errorText = "Stopped";
            }
            break;
        }

        if (!result.ok()) {
            const std::string message = Api::describe(result);
            std::lock_guard<std::mutex> lock(stateMutex_);
            if (generation != accountGeneration_.load() || assistantIndex >= messages_.size()) {
                turnFinished_ = true;
                return;
            }
            messages_[assistantIndex].errorText = message;
            break;
        }

        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            if (generation != accountGeneration_.load() || assistantIndex >= messages_.size()) {
                turnFinished_ = true;
                return;
            }
            assistant = messages_[assistantIndex];
        }
        if (!assistant.errorText.empty()) break;
        if (!assistant.hasPendingToolCalls()) break;

        resolvePendingToolCalls(assistant, assistantIndex, generation);
        if (generation != accountGeneration_.load()) {
            turnFinished_ = true;
            return;
        }
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            if (generation != accountGeneration_.load() || assistantIndex >= messages_.size()) {
                turnFinished_ = true;
                return;
            }
            messages_[assistantIndex] = assistant;
            streamStatus_ = "Thinking...";
        }
        scrollToBottom_ = true;
    }

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (generation == accountGeneration_.load() && assistantIndex < messages_.size()) {
            messages_[assistantIndex].streaming = false;
        }
        streaming_ = false;
        streamStatus_.clear();
    }
    scrollToBottom_ = true;

    if (!cancelTurn_ && signedIn_ && generation == accountGeneration_.load()) {
        refreshCredits();
        refreshSessions(); // lastActivityAt moved, so the sidebar order is stale
    }
    turnFinished_ = true;
}

void App::resolvePendingToolCalls(Message& message,
                                  size_t assistantIndex,
                                  unsigned long long generation) {
    ToolContext context;
    context.projectDir = turnProjectDir_;
    context.mode = turnMode_;
    context.settings = &settings_;
    context.permissions = &permissions_;
    context.todos = &todos_;
    context.cancelled = [this] { return cancelTurn_.load(); };

    for (Part& part : message.parts) {
        if (generation != accountGeneration_.load()) return;
        if (part.kind != PartKind::Tool) continue;
        if (part.tool.state == ToolState::OutputAvailable || part.tool.state == ToolState::OutputError) {
            continue;
        }

        if (cancelTurn_) {
            part.tool.state = ToolState::OutputError;
            part.tool.errorText = "Stopped before this tool ran";
            part.tool.finishedMs = nowMs();
            continue;
        }

        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            if (generation != accountGeneration_.load()) return;
            streamStatus_ = "Running " + part.tool.toolName + "...";
        }

        const ToolResult result = executeLocalTool(part.tool.toolName, part.tool.input, context);
        if (result.ok) {
            part.tool.state = ToolState::OutputAvailable;
            part.tool.output = result.output;
        } else {
            // Tool failures go back to the model as tool errors rather than
            // aborting the turn: it is expected to read them and adapt.
            part.tool.state = ToolState::OutputError;
            part.tool.errorText = result.error;
        }
        part.tool.finishedMs = nowMs();

        // Publish as it lands rather than after the whole batch, so a slow
        // command shows its result the moment it finishes.
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            if (generation != accountGeneration_.load() || assistantIndex >= messages_.size()) return;
            messages_[assistantIndex] = message;
        }
        scrollToBottom_ = true;
    }
}

} // namespace dc
