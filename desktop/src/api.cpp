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

Api::Api(Settings& settings) : settings_(settings) {
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

void Api::reloadAuthFromDisk() {
    AuthData fresh;
    const bool ok = loadAuth(fresh);
    std::lock_guard<std::mutex> lock(mutex_);
    auth_ = ok ? fresh : AuthData{};
}

void Api::signOut() {
    if (signedIn()) {
        // Best effort: a network failure must never strand the user signed in.
        post("/auth/logout", json::object());
    }
    clearAuth();
    std::lock_guard<std::mutex> lock(mutex_);
    auth_ = AuthData{};
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

HttpHeaders Api::headers(bool includeByok) {
    HttpHeaders out;
    out.emplace_back("Content-Type", "application/json");
    out.emplace_back("Accept", "application/json, text/event-stream");

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (auth_.valid()) out.emplace_back("Authorization", "Bearer " + auth_.token);
    }

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

bool Api::refresh() {
    std::string refreshToken;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        refreshToken = auth_.refreshToken;
    }
    if (refreshToken.empty()) return false;

    json body = json::object();
    body["refresh_token"] = refreshToken;

    HttpHeaders plain;
    plain.emplace_back("Content-Type", "application/json");

    const HttpResult result =
        httpRequest("POST", joinUrl(settings_.apiUrl, "/auth/refresh"), plain, body.dump(), 30000);
    if (!result.ok()) return false;

    const json parsed = json::parse(result.body, nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object() || !parsed.contains("accessToken")) return false;

    AuthData updated;
    updated.token = parsed.value("accessToken", std::string());
    updated.refreshToken = parsed.value("refreshToken", refreshToken);
    if (parsed.contains("expiresInSec") && parsed["expiresInSec"].is_number()) {
        updated.expiresAtMs = nowMs() + parsed["expiresInSec"].get<long long>() * 1000;
    }
    if (updated.token.empty()) return false;

    saveAuth(updated);
    {
        std::lock_guard<std::mutex> lock(mutex_);
        auth_ = updated;
    }
    return true;
}

bool Api::ensureFreshToken() {
    bool stale = false;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!auth_.valid()) return false;
        stale = accessTokenExpired(auth_);
    }
    if (!stale) return true;
    return refresh();
}

HttpResult Api::get(const std::string& path) {
    ensureFreshToken();
    HttpResult result = httpRequest("GET", joinUrl(settings_.apiUrl, path), headers(false), std::string());
    if (result.status == 401 && refresh()) {
        result = httpRequest("GET", joinUrl(settings_.apiUrl, path), headers(false), std::string());
    }
    if (result.status == 401) clearAuth();
    return result;
}

HttpResult Api::post(const std::string& path, const json& body) {
    ensureFreshToken();
    const std::string payload = body.dump();
    HttpResult result = httpRequest("POST", joinUrl(settings_.apiUrl, path), headers(false), payload);
    if (result.status == 401 && refresh()) {
        result = httpRequest("POST", joinUrl(settings_.apiUrl, path), headers(false), payload);
    }
    if (result.status == 401) clearAuth();
    return result;
}

HttpResult Api::streamChat(const json& body, const StreamSink& sink) {
    ensureFreshToken();
    const std::string payload = body.dump();
    const std::string url = joinUrl(settings_.apiUrl, "/chat");

    HttpResult result = httpStream("POST", url, headers(true), payload, sink);
    // A 401 is returned before any body is streamed, so replaying is safe.
    if (result.status == 401 && refresh()) {
        result = httpStream("POST", url, headers(true), payload, sink);
    }
    if (result.status == 401) clearAuth();
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
