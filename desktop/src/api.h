// DarkCode API client: /sessions, /chat, /billing, /auth/refresh.
//
// Auth mirrors the CLI's api-client.ts — refresh proactively when the access
// token is stale, and replay once on a 401 before giving up.
#pragma once

#include <mutex>
#include <string>
#include <vector>

#include "config.h"
#include "http.h"
#include "json.h"

namespace dc {

struct SessionSummary {
    std::string id;
    std::string title;
    std::string createdAt;
    std::string lastActivityAt;
};

class Api {
public:
    explicit Api(Settings& settings);

    bool signedIn();
    AuthData auth();
    void reloadAuthFromDisk();
    /// Best-effort server-side revoke; always clears the local token file.
    void signOut();

    HttpResult get(const std::string& path);
    HttpResult post(const std::string& path, const json& body);
    HttpResult streamChat(const json& body, const StreamSink& sink);

    /// Convenience wrappers. `error` is filled with a user-facing message.
    bool listSessions(std::vector<SessionSummary>& out, std::string& error);
    bool createSession(const std::string& title, SessionSummary& out, std::string& error);
    bool getSessionMessages(const std::string& id, json& messagesOut, std::string& error);
    bool getCreditBalance(double& out, std::string& error);

    /// Pulls a human-readable message out of a JSON error body.
    static std::string describe(const HttpResult& result);

private:
    HttpHeaders headers(bool includeByok);
    bool ensureFreshToken();
    bool refresh();

    Settings& settings_;
    std::mutex mutex_;
    AuthData auth_;
};

} // namespace dc
