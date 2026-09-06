#pragma once

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>

#include "http.h"
#include "json.h"

namespace dc {

inline constexpr std::string_view kChatGptModel = "chatgpt-gpt-5.4";
inline constexpr std::string_view kChatGptProvider = "openai-codex";
inline constexpr char kChatGptClientId[] = "app_EMoamEEZ73f0CkXaXp7hrann";

struct ChatGptTokens {
    std::string accessToken;
    std::string refreshToken;
    std::string accountId;
    long long expiresAtMs = 0;
};

// Parsing is for routing metadata, not JWT signature verification. Tokens are
// accepted only from the fixed HTTPS issuer or the desktop's DPAPI store.
bool parseChatGptTokens(const json& value, const ChatGptTokens& previous,
                       ChatGptTokens& out, long long now);
std::string chatGptAuthorizationUrl(const std::string& state, const std::string& challenge);
bool parseChatGptCallback(std::string_view target, std::string_view state,
                         std::string& code, std::string& error);
bool appendChatGptHeaders(std::string_view model, const std::string& origin,
                         const ChatGptTokens& tokens, HttpHeaders& headers, std::string& error);

struct ChatGptStatus {
    bool busy = false;
    bool available = false; // usable now, or refreshable locally before sending
    bool connected = false;
    bool signingIn = false;
    std::string label;
    std::string error;
};

class ChatGptAuth {
public:
    ChatGptAuth();
    ~ChatGptAuth();
    ChatGptAuth(const ChatGptAuth&) = delete;
    ChatGptAuth& operator=(const ChatGptAuth&) = delete;
    // UI thread owns login-thread lifecycle. Refresh can run on API workers.
    void connect();
    void cancel();
    void disconnect();
    void shutdown();
    ChatGptStatus status();
    bool requestHeaders(std::string_view model, const std::string& origin,
                        HttpHeaders& headers, std::string& error,
                        const CancelCheck& cancelled = {});

private:
    bool save(const ChatGptTokens& tokens);
    bool erase();
    std::mutex mutex_;
    std::condition_variable cv_;
    ChatGptTokens tokens_;
    std::string error_;
    std::string path_;
    void* storeLock_ = nullptr;
    unsigned long long generation_ = 0;
    bool refreshing_ = false;
    bool connecting_ = false;
    std::atomic<bool> cancelLogin_{false};
    std::atomic<bool> stopped_{false};
    std::thread loginThread_;
};

} // namespace dc
