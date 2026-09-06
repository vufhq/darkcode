#include "api.h"

#include "models.h"
#include "util.h"

namespace dc {
namespace {

std::string joinUrl(const std::string& base, const std::string& path) {
    if (path.empty()) return base;
    if (path.front() == '/') return base + path;
    return base + "/" + path;
}

} // namespace

Api::Api(const Settings& settings) : apiUrl_(settings.apiUrl) {
    loadAuth(auth_);
}

bool Api::signedIn() {
    std::lock_guard<std::mutex> lock(mutex_);
    return auth_.valid();
}

AuthData Api::auth() {
    std::lock_guard<std::mutex> lock(mutex_);
    return auth_;
}

void Api::setAuth(const AuthData& auth) {
    std::lock_guard<std::mutex> lock(mutex_);
    AuthData bound = auth;
    bound.apiUrl = apiUrl_;
    saveAuth(bound);
    auth_ = std::move(bound);
    ++authGeneration_;
}

void Api::setOrigin(const std::string& apiUrl, bool clearCredentials) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (apiUrl_ == apiUrl) return;
    const std::string credentialOrigin = auth_.apiUrl.empty() ? "https://api.darkcode.sh" : auth_.apiUrl;
    if (clearCredentials || (auth_.valid() && credentialOrigin != apiUrl)) {
        clearAuth();
        auth_ = AuthData{};
    }
    apiUrl_ = apiUrl;
    ++authGeneration_;
}

std::string Api::origin() {
    std::lock_guard<std::mutex> lock(mutex_);
    return apiUrl_;
}

void Api::reloadAuthFromDisk() {
    std::lock_guard<std::mutex> lock(mutex_);
    AuthData fresh;
    const bool ok = loadAuth(fresh);
    const std::string credentialOrigin = fresh.apiUrl.empty() ? "https://api.darkcode.sh" : fresh.apiUrl;
    auth_ = ok && credentialOrigin == apiUrl_ ? fresh : AuthData{};
    ++authGeneration_;
}

SignOutContext Api::prepareSignOut() {
    std::lock_guard<std::mutex> lock(mutex_);
    SignOutContext context{auth_.token, apiUrl_};
    clearAuth();
    auth_ = AuthData{};
    ++authGeneration_;
    return context;
}

void Api::revokeAccessToken(const SignOutContext& context) {
    if (context.accessToken.empty()) return;
    std::string originError;
    if (!validateOrigin(context.apiUrl, originError)) return;
    const HttpHeaders headers{{"Content-Type", "application/json"},
                              {"Authorization", "Bearer " + context.accessToken}};
    httpRequest("POST", joinUrl(context.apiUrl, "/auth/logout"), headers,
                json::object().dump(), 30000, false);
}

void Api::invalidateAuth(unsigned long long expectedGeneration) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (authGeneration_ != expectedGeneration) return;
    clearAuth();
    auth_ = AuthData{};
    ++authGeneration_;
}

bool Api::validateOrigin(const std::string& apiUrl, std::string& error) {
    return isSafeApiUrl(apiUrl, error);
}

std::string Api::describe(const HttpResult& result) {
    if (!result.error.empty()) return result.error;
    if (!result.body.empty()) {
        const json parsed = json::parse(result.body, nullptr, false);
        if (!parsed.is_discarded() && parsed.is_object() && parsed.contains("error")) {
            const auto& value = parsed["error"];
            if (value.is_string()) return value.get<std::string>();
            return value.dump();
        }
        if (result.body.size() < 300) return result.body;
    }
    return "Request failed with status " + std::to_string(result.status);
}

HttpHeaders Api::headers(const AuthData& auth, bool includeByok) {
    HttpHeaders out;
    out.emplace_back("Content-Type", "application/json");
    out.emplace_back("Accept", "application/json, text/event-stream");

    if (auth.valid()) out.emplace_back("Authorization", "Bearer " + auth.token);

    if (includeByok) {
        // The server ignores keys it doesn't need, so sending every stored key
        // is safe and keeps the model picker free of special cases.
        const auto keys = loadApiKeys();
        for (const auto& provider : kByokProviders) {
            const auto it = keys.find(std::string(provider.id));
            if (it != keys.end() && !it->second.empty()) {
                out.emplace_back(std::string(provider.header), it->second);
            }
        }
    }
    return out;
}

bool Api::refresh(const RequestContext& context) {
    std::string refreshToken;
    std::string apiUrl;
    unsigned long long generation = 0;
    {
        std::unique_lock<std::mutex> lock(mutex_);
        if (authGeneration_ != context.generation || apiUrl_ != context.apiUrl) return false;
        if (auth_.token != context.auth.token) return auth_.valid();
        if (refreshInProgress_) {
            refreshCv_.wait(lock, [this] { return !refreshInProgress_; });
            if (authGeneration_ != context.generation || apiUrl_ != context.apiUrl) return false;
            if (auth_.token != context.auth.token) return auth_.valid();
            return lastRefreshSucceeded_;
        }
        refreshToken = auth_.refreshToken;
        if (refreshToken.empty()) return false;
        generation = authGeneration_;
        apiUrl = apiUrl_;
        refreshInProgress_ = true;
    }

    json body = json::object();
    body["refresh_token"] = refreshToken;

    HttpHeaders plain;
    plain.emplace_back("Content-Type", "application/json");

    std::string originError;
    HttpResult result;
    if (!validateOrigin(apiUrl, originError)) {
        result.error = originError;
    } else {
        result = httpRequest("POST", joinUrl(apiUrl, "/auth/refresh"), plain,
                             body.dump(), 30000, false);
    }

    AuthData updated;
    bool succeeded = false;
    if (result.ok()) {
        const json parsed = json::parse(result.body, nullptr, false);
        if (!parsed.is_discarded() && parsed.is_object() && parsed.contains("accessToken")) {
            updated.token = parsed.value("accessToken", std::string());
            updated.refreshToken = parsed.value("refreshToken", refreshToken);
            updated.apiUrl = apiUrl;
            if (parsed.contains("expiresInSec") && parsed["expiresInSec"].is_number()) {
                updated.expiresAtMs = nowMs() + parsed["expiresInSec"].get<long long>() * 1000;
            }
            succeeded = updated.valid();
        }
    }

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (generation != authGeneration_) {
            succeeded = false; // sign-out or another credential replacement won the race
        } else if (succeeded) {
            saveAuth(updated);
            auth_ = updated;
        } else if (result.status == 401) {
            clearAuth();
            auth_ = AuthData{};
            ++authGeneration_;
        }
        lastRefreshSucceeded_ = succeeded;
        refreshInProgress_ = false;
    }
    refreshCv_.notify_all();
    return succeeded;
}

bool Api::requestContext(RequestContext& context) {
    for (;;) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (!auth_.valid()) return false;
            context = RequestContext{auth_, apiUrl_, authGeneration_};
            if (!accessTokenExpired(auth_)) return true;
        }

        if (context.auth.refreshToken.empty()) {
            invalidateAuth(context.generation);
            return false;
        }
        if (!refresh(context)) return false;
    }
}

bool Api::contextCurrent(const RequestContext& context) {
    std::lock_guard<std::mutex> lock(mutex_);
    return authGeneration_ == context.generation && apiUrl_ == context.apiUrl;
}

HttpResult Api::get(const std::string& path) {
    RequestContext context;
    if (!requestContext(context)) return {0, {}, "Your sign-in has expired. Sign in again to continue."};
    std::string originError;
    if (!validateOrigin(context.apiUrl, originError)) return {0, {}, originError};
    HttpResult result = httpRequest("GET", joinUrl(context.apiUrl, path), headers(context.auth, false),
                                    std::string(), 60000, false);
    RequestContext retry;
    if (result.status == 401 && refresh(context) && requestContext(retry) &&
        retry.generation == context.generation && retry.apiUrl == context.apiUrl) {
        result = httpRequest("GET", joinUrl(retry.apiUrl, path), headers(retry.auth, false),
                             std::string(), 60000, false);
    }
    if (result.status == 401) invalidateAuth(context.generation);
    return result;
}

HttpResult Api::post(const std::string& path, const json& body) {
    return postRequest(path, body, false);
}

bool Api::inferenceHeaders(const RequestContext& context, const json& body, HttpHeaders& out,
                           std::string& error, const CancelCheck& cancelled) {
    const std::string model = body.value("model", body.value("summarizerModel", std::string()));
    out = headers(context.auth, model != kChatGptModel);
    return chatGpt_.requestHeaders(model, context.apiUrl, out, error, cancelled);
}

bool Api::compactSession(const std::string& id, const std::string& model, std::string& error) {
    const auto result = postRequest("/sessions/" + id + "/compact", json{{"summarizerModel", model}}, true);
    if (!result.ok()) {
        error = model == kChatGptModel && result.status != 0
            ? "ChatGPT compaction failed (HTTP " + std::to_string(result.status) +
              "). Check your connection or reconnect in Settings > Models. No fallback was used."
            : describe(result);
        return false;
    }
    return true;
}

HttpResult Api::postRequest(const std::string& path, const json& body, bool inference) {
    RequestContext context;
    if (!requestContext(context)) return {0, {}, "Your sign-in has expired. Sign in again to continue."};
    std::string originError;
    if (!validateOrigin(context.apiUrl, originError)) return {0, {}, originError};
    const std::string payload = body.dump();
    HttpHeaders requestHeaders = headers(context.auth, false);
    if (inference && !inferenceHeaders(context, body, requestHeaders, originError)) return {0, {}, originError};
    if (!contextCurrent(context)) return {0, {}, {}, true};
    HttpResult result = httpRequest("POST", joinUrl(context.apiUrl, path), requestHeaders,
                                     payload, 60000, false);
    RequestContext retry;
    if (result.status == 401 && refresh(context) && requestContext(retry) &&
        retry.generation == context.generation && retry.apiUrl == context.apiUrl) {
        requestHeaders = headers(retry.auth, false);
        if (inference && !inferenceHeaders(retry, body, requestHeaders, originError)) return {0, {}, originError};
        if (!contextCurrent(retry)) return {0, {}, {}, true};
        result = httpRequest("POST", joinUrl(retry.apiUrl, path), requestHeaders,
                              payload, 60000, false);
    }
    if (result.status == 401) invalidateAuth(context.generation);
    return result;
}

HttpResult Api::streamChat(const json& body,
                           const StreamSink& sink,
                           const CancelCheck& shouldCancel) {
    RequestContext context;
    if (!requestContext(context)) return {0, {}, "Your sign-in has expired. Sign in again to continue."};
    std::string originError;
    if (!validateOrigin(context.apiUrl, originError)) return {0, {}, originError};
    const std::string payload = body.dump();
    const std::string url = joinUrl(context.apiUrl, "/chat");

    HttpHeaders requestHeaders;
    if (!inferenceHeaders(context, body, requestHeaders, originError, shouldCancel)) return {0, {}, originError};
    if (!contextCurrent(context)) return {0, {}, {}, true};
    HttpResult result = httpStream("POST", url, requestHeaders, payload, sink, shouldCancel);
    // A 401 is returned before any body is streamed, so replaying is safe.
    RequestContext retry;
    if (result.status == 401 && refresh(context) && requestContext(retry) &&
        retry.generation == context.generation && retry.apiUrl == context.apiUrl) {
        HttpHeaders retryHeaders;
        if (!inferenceHeaders(retry, body, retryHeaders, originError, shouldCancel)) return {0, {}, originError};
        if (!contextCurrent(retry)) return {0, {}, {}, true};
        result = httpStream("POST", joinUrl(retry.apiUrl, "/chat"), retryHeaders, payload,
                            sink, shouldCancel);
    }
    if (result.status == 401) invalidateAuth(context.generation);
    if (!result.ok() && !result.aborted && body.value("model", std::string()) == kChatGptModel) {
        result.body.clear();
        result.error = "ChatGPT request failed (HTTP " + std::to_string(result.status) +
            "). Check your connection or reconnect in Settings > Models. No fallback was used.";
    }
    return result;
}

bool Api::listSessions(std::vector<SessionSummary>& out, std::string& error) {
    const HttpResult result = get("/sessions");
    if (!result.ok()) {
        error = describe(result);
        return false;
    }
    const json parsed = json::parse(result.body, nullptr, false);
    if (parsed.is_discarded() || !parsed.contains("sessions") || !parsed["sessions"].is_array()) {
        error = "Unexpected response from /sessions";
        return false;
    }
    out.clear();
    for (const auto& entry : parsed["sessions"]) {
        SessionSummary summary;
        summary.id = entry.value("id", std::string());
        summary.title = entry.value("title", std::string("Untitled session"));
        summary.createdAt = entry.value("createdAt", std::string());
        summary.lastActivityAt = entry.value("lastActivityAt", std::string());
        if (!summary.id.empty()) out.push_back(std::move(summary));
    }
    return true;
}

bool Api::createSession(const std::string& title, SessionSummary& out, std::string& error) {
    json body = json::object();
    body["title"] = title;

    const HttpResult result = post("/sessions", body);
    if (!result.ok()) {
        error = describe(result);
        return false;
    }
    const json parsed = json::parse(result.body, nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object()) {
        error = "Unexpected response creating the session";
        return false;
    }
    out.id = parsed.value("id", std::string());
    out.title = parsed.value("title", title);
    out.createdAt = parsed.value("createdAt", std::string());
    out.lastActivityAt = out.createdAt;
    if (out.id.empty()) {
        error = "Server returned a session without an id";
        return false;
    }
    return true;
}

bool Api::getSessionMessages(const std::string& id, json& messagesOut, std::string& error) {
    const HttpResult result = get("/sessions/" + id);
    if (!result.ok()) {
        error = describe(result);
        return false;
    }
    const json parsed = json::parse(result.body, nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object()) {
        error = "Unexpected response loading the session";
        return false;
    }
    messagesOut = parsed.contains("messages") && parsed["messages"].is_array() ? parsed["messages"]
                                                                              : json::array();
    return true;
}

bool Api::getCreditBalance(double& out, std::string& error) {
    const HttpResult result = get("/billing/balance");
    if (!result.ok()) {
        error = describe(result);
        return false;
    }
    const json parsed = json::parse(result.body, nullptr, false);
    if (parsed.is_discarded() || !parsed.contains("credits") || !parsed["credits"].is_number()) {
        error = "Unexpected response from /billing/balance";
        return false;
    }
    out = parsed["credits"].get<double>();
    return true;
}

} // namespace dc
