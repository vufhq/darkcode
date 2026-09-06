// DarkCode API client: /sessions, /chat, /billing, /auth/refresh.
//
// Auth mirrors the CLI's api-client.ts — refresh proactively when the access
// token is stale, and replay once on a 401 before giving up.
#pragma once

#include <mutex>
#include <condition_variable>
#include <string>
#include <vector>

#include "config.h"
#include "chatgpt_auth.h"
#include "http.h"
#include "json.h"

namespace dc {

struct SessionSummary {
    std::string id;
    std::string title;
    std::string createdAt;
    std::string lastActivityAt;
};

struct SignOutContext {
    std::string accessToken;
    std::string apiUrl;
};

class Api {
public:
    explicit Api(const Settings& settings);

    bool signedIn();
    AuthData auth();
    void setAuth(const AuthData& auth);
    void setOrigin(const std::string& apiUrl, bool clearCredentials = true);
    std::string origin();
    ChatGptAuth& chatGpt() { return chatGpt_; }
    void reloadAuthFromDisk();
    /// Clears memory and disk synchronously, returning the access token for a
    /// best-effort revocation on a worker thread.
    SignOutContext prepareSignOut();
    void revokeAccessToken(const SignOutContext& context);

    HttpResult get(const std::string& path);
    HttpResult post(const std::string& path, const json& body);
    bool compactSession(const std::string& id, const std::string& model, std::string& error);
    HttpResult streamChat(const json& body,
                          const StreamSink& sink,
                          const CancelCheck& shouldCancel = {});

    /// Convenience wrappers. `error` is filled with a user-facing message.
    bool listSessions(std::vector<SessionSummary>& out, std::string& error);
    bool createSession(const std::string& title, SessionSummary& out, std::string& error);
    bool getSessionMessages(const std::string& id, json& messagesOut, std::string& error);
    bool getCreditBalance(double& out, std::string& error);

    /// Pulls a human-readable message out of a JSON error body.
    static std::string describe(const HttpResult& result);

private:
    struct RequestContext {
        AuthData auth;
        std::string apiUrl;
        unsigned long long generation = 0;
    };

    HttpHeaders headers(const AuthData& auth, bool includeByok);
    bool inferenceHeaders(const RequestContext& context, const json& body, HttpHeaders& out,
                          std::string& error, const CancelCheck& cancelled = {});
    HttpResult postRequest(const std::string& path, const json& body, bool inference);
    bool requestContext(RequestContext& context);
    bool contextCurrent(const RequestContext& context);
    bool refresh(const RequestContext& context);
    void invalidateAuth(unsigned long long expectedGeneration);
    static bool validateOrigin(const std::string& apiUrl, std::string& error);

    std::mutex mutex_;
    ChatGptAuth chatGpt_;
    std::condition_variable refreshCv_;
    AuthData auth_;
    std::string apiUrl_;
    bool refreshInProgress_ = false;
    bool lastRefreshSucceeded_ = false;
    unsigned long long authGeneration_ = 0;
};

} // namespace dc
