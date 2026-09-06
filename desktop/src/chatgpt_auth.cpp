#include "chatgpt_auth.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winhttp.h>
#include <wincrypt.h>
#include <bcrypt.h>
#include <shellapi.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>

#include "config.h"
#include "oauth.h"
#include "util.h"

namespace dc {
namespace {
using Clock = std::chrono::steady_clock;
constexpr char kRedirect[] = "http://localhost:1455/auth/callback";
constexpr char kNeeded[] = "Connect ChatGPT in Settings > Models. No hosted or API-key fallback is used.";

bool safeValue(std::string_view value, size_t cap = 32768) {
    return !value.empty() && value.size() <= cap &&
        std::all_of(value.begin(), value.end(), [](unsigned char c) { return c > 32 && c < 127; });
}

std::string encode(std::string_view value) {
    constexpr char hex[] = "0123456789ABCDEF";
    std::string out;
    for (const unsigned char c : value) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') out += static_cast<char>(c);
        else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
    }
    return out;
}

bool decode(std::string_view value, std::string& out) {
    out.clear();
    auto hex = [](char c) { return c >= '0' && c <= '9' ? c - '0' :
        c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; };
    for (size_t i = 0; i < value.size(); ++i) {
        if (value[i] == '%') {
            if (i + 2 >= value.size() || hex(value[i + 1]) < 0 || hex(value[i + 2]) < 0) return false;
            out += static_cast<char>(hex(value[i + 1]) * 16 + hex(value[i + 2]));
            i += 2;
        } else out += value[i] == '+' ? ' ' : value[i];
    }
    return true;
}

json claims(const std::string& jwt) {
    const auto first = jwt.find('.');
    const auto last = first == std::string::npos ? first : jwt.find('.', first + 1);
    if (first == std::string::npos || last == std::string::npos || jwt.size() > 32768) return {};
    std::string raw;
    unsigned int bits = 0;
    int count = 0;
    constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const auto payload = std::string_view(jwt).substr(first + 1, last - first - 1);
    if (payload.size() % 4 == 1) return {};
    for (const char c : payload) {
        const auto index = alphabet.find(c);
        if (index == std::string_view::npos) return {};
        bits = (bits << 6) | static_cast<unsigned int>(index);
        count += 6;
        if (count >= 8) { count -= 8; raw += static_cast<char>((bits >> count) & 255); }
    }
    auto parsed = json::parse(raw, nullptr, false);
    return parsed.is_object() ? parsed : json::object();
}

std::string stringField(const json& value, const char* key) {
    const auto it = value.find(key);
    return it != value.end() && it->is_string() ? it->get<std::string>() : std::string();
}

std::string account(const json& value) {
    const auto it = value.find("https://api.openai.com/auth");
    return it != value.end() && it->is_object() ? stringField(*it, "chatgpt_account_id") : std::string();
}

struct InternetCloser {
    HANDLE closed = nullptr;
    void operator()(void* h) const {
        if (!h) return;
        ::WinHttpCloseHandle(h);
        if (closed) ::WaitForSingleObject(closed, INFINITE);
    }
};
using Internet = std::unique_ptr<void, InternetCloser>;
struct HandleCloser { void operator()(void* h) const { if (h && h != INVALID_HANDLE_VALUE) ::CloseHandle(h); } };
using Handle = std::unique_ptr<void, HandleCloser>;

// Async WinHTTP allows cancellation even during DNS, TLS and response headers.
// HANDLE_CLOSING is awaited before destroying callback state or request buffers.
struct TokenRequest {
    Handle event{::CreateEventW(nullptr, FALSE, FALSE, nullptr)};
    Handle closed{::CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    std::atomic<bool> failed{false};
    std::atomic<DWORD> bytes{0};
};

void CALLBACK tokenCallback(HINTERNET, DWORD_PTR context, DWORD status, void*, DWORD length) {
    auto* state = reinterpret_cast<TokenRequest*>(context);
    if (!state) return;
    if (status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING) { ::SetEvent(state->closed.get()); return; }
    if (status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR) state->failed = true;
    if (status == WINHTTP_CALLBACK_STATUS_READ_COMPLETE) state->bytes = length;
    if (status == WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE || status == WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE ||
        status == WINHTTP_CALLBACK_STATUS_READ_COMPLETE || status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR)
        ::SetEvent(state->event.get());
}

HttpResult tokenRequest(const std::string& form, const CancelCheck& cancelled) {
    HttpResult result;
    result.error = "ChatGPT token exchange failed. Reconnect or try again.";
    TokenRequest state;
    std::array<char, 4096> buffer{};
    if (!state.event || !state.closed) return result;
    Internet session(::WinHttpOpen(L"DarkCode-Desktop", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, WINHTTP_FLAG_ASYNC));
    if (!session) return result;
    Internet connection(::WinHttpConnect(session.get(), L"auth.openai.com", 443, 0));
    if (!connection) return result;
    Internet request(::WinHttpOpenRequest(connection.get(), L"POST", L"/oauth/token", nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE));
    if (!request) return result;
    DWORD disable = WINHTTP_DISABLE_REDIRECTS;
    if (!::WinHttpSetOption(request.get(), WINHTTP_OPTION_DISABLE_FEATURE, &disable, sizeof(disable))) return result;
    DWORD_PTR context = reinterpret_cast<DWORD_PTR>(&state);
    if (!::WinHttpSetOption(request.get(), WINHTTP_OPTION_CONTEXT_VALUE, &context, sizeof(context))) return result;
    if (::WinHttpSetStatusCallback(request.get(), tokenCallback,
        WINHTTP_CALLBACK_FLAG_ALL_COMPLETIONS | WINHTTP_CALLBACK_FLAG_HANDLES, 0) == WINHTTP_INVALID_STATUS_CALLBACK) return result;
    request.get_deleter().closed = state.closed.get();
    const auto deadline = Clock::now() + std::chrono::seconds(30);
    auto wait = [&] {
        while (Clock::now() < deadline && !(cancelled && cancelled())) {
            if (::WaitForSingleObject(state.event.get(), 50) == WAIT_OBJECT_0) return !state.failed.load();
        }
        return false;
    };
    const auto pending = [](BOOL ok) { return ok || ::GetLastError() == ERROR_IO_PENDING; };
    bool ok = !(cancelled && cancelled()) && pending(::WinHttpSendRequest(request.get(),
        L"Content-Type: application/x-www-form-urlencoded\r\nAccept: application/json\r\n", static_cast<DWORD>(-1),
        const_cast<char*>(form.data()), static_cast<DWORD>(form.size()), static_cast<DWORD>(form.size()), context)) && wait();
    if (ok) ok = pending(::WinHttpReceiveResponse(request.get(), nullptr)) && wait();
    if (ok) {
        DWORD status = 0, size = sizeof(status);
        ok = ::WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX) != FALSE;
        result.status = status;
    }
    while (ok) {
        ok = pending(::WinHttpReadData(request.get(), buffer.data(), static_cast<DWORD>(buffer.size()), nullptr)) && wait();
        if (!ok || state.bytes == 0) break;
        if (result.body.size() + state.bytes > 65536) { ok = false; break; }
        result.body.append(buffer.data(), state.bytes);
    }
    request.reset();
    if (ok) result.error.clear();
    else result.body.clear();
    return result;
}

struct Socket {
    SOCKET value = INVALID_SOCKET;
    ~Socket() { if (value != INVALID_SOCKET) ::closesocket(value); }
};

bool browserLogin(const std::atomic<bool>& cancelled, ChatGptTokens& tokens, std::string& error) {
    std::array<unsigned char, 32> random{}, hash{};
    if (::BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return false;
    const auto verifier = base64UrlEncode(random.data(), random.size());
    if (::BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, reinterpret_cast<PUCHAR>(const_cast<char*>(verifier.data())),
        static_cast<ULONG>(verifier.size()), hash.data(), static_cast<ULONG>(hash.size())) < 0) return false;
    if (::BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return false;
    const auto state = base64UrlEncode(random.data(), random.size());
    WSADATA data{};
    if (::WSAStartup(MAKEWORD(2, 2), &data) != 0) return false;
    struct Cleanup { ~Cleanup() { ::WSACleanup(); } } cleanup;
    Socket listener{::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)};
    BOOL exclusive = TRUE;
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(1455);
    if (listener.value == INVALID_SOCKET || ::setsockopt(listener.value, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
        reinterpret_cast<const char*>(&exclusive), sizeof(exclusive)) != 0 ||
        ::bind(listener.value, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) != 0 ||
        ::listen(listener.value, 4) != 0) {
        error = "Cannot listen on 127.0.0.1:1455. Close other Codex sign-in attempts and reconnect.";
        return false;
    }
    const auto url = chatGptAuthorizationUrl(state, base64UrlEncode(hash.data(), hash.size()));
    u_long listenerNonblocking = 1;
    if (::ioctlsocket(listener.value, FIONBIO, &listenerNonblocking) != 0) return false;
    if (cancelled) return false;
    if (reinterpret_cast<INT_PTR>(::ShellExecuteW(nullptr, L"open", toWide(url).c_str(), nullptr, nullptr, SW_SHOWNORMAL)) <= 32) {
        error = "Could not open the default browser. Check Windows browser settings.";
        return false;
    }
    const auto deadline = Clock::now() + std::chrono::minutes(5);
    auto readable = [](SOCKET socket) {
        fd_set set; FD_ZERO(&set); FD_SET(socket, &set);
        timeval timeout{0, 100000};
        return ::select(0, &set, nullptr, nullptr, &timeout) > 0;
    };
    while (!cancelled && Clock::now() < deadline) {
        if (!readable(listener.value)) continue;
        Socket client{::accept(listener.value, nullptr, nullptr)};
        if (client.value == INVALID_SOCKET) continue;
        u_long nonblocking = 1;
        if (::ioctlsocket(client.value, FIONBIO, &nonblocking) != 0) continue;
        std::string request;
        const auto readDeadline = std::min(deadline, Clock::now() + std::chrono::seconds(3));
        while (!cancelled && Clock::now() < readDeadline && request.size() < 16384 && request.find("\r\n\r\n") == std::string::npos) {
            if (!readable(client.value)) continue;
            std::array<char, 2048> buffer{};
            const int count = ::recv(client.value, buffer.data(), static_cast<int>(buffer.size()), 0);
            if (count <= 0) break;
            request.append(buffer.data(), static_cast<size_t>(count));
        }
        std::string code, callbackError;
        const auto end = request.find(' ', 4);
        const bool valid = request.starts_with("GET ") && end != std::string::npos && request.size() <= 16384 &&
            request.find("\r\n\r\n") != std::string::npos && parseChatGptCallback(std::string_view(request).substr(4, end - 4), state, code, callbackError);
        const char* response = valid ? "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nConnection: close\r\n\r\nReturn to DarkCode to see the sign-in result." :
            "HTTP/1.1 400 Bad Request\r\nCache-Control: no-store\r\nConnection: close\r\n\r\nInvalid callback.";
        ::send(client.value, response, static_cast<int>(std::char_traits<char>::length(response)), 0);
        if (!valid) continue;
        // One valid state consumes the attempt, including provider denial.
        ::closesocket(listener.value); listener.value = INVALID_SOCKET;
        if (!callbackError.empty()) { error = callbackError; return false; }
        if (cancelled) return false;
        const auto result = tokenRequest("grant_type=authorization_code&client_id=" + std::string(kChatGptClientId) +
            "&redirect_uri=" + encode(kRedirect) + "&code=" + encode(code) + "&code_verifier=" + encode(verifier), [&] { return cancelled.load(); });
        if (!result.ok() || !parseChatGptTokens(json::parse(result.body, nullptr, false), {}, tokens, nowMs())) {
            error = "ChatGPT sign-in could not be completed. Check account access and reconnect.";
            return false;
        }
        return !cancelled;
    }
    error = cancelled ? "ChatGPT sign-in cancelled." : "ChatGPT sign-in timed out. Reconnect to try again.";
    return false;
}
} // namespace

bool parseChatGptTokens(const json& value, const ChatGptTokens& previous, ChatGptTokens& out, long long now) {
    if (!value.is_object()) return false;
    ChatGptTokens parsed;
    parsed.accessToken = stringField(value, "access_token");
    parsed.refreshToken = value.contains("refresh_token") ? stringField(value, "refresh_token") : previous.refreshToken;
    if (!safeValue(parsed.accessToken) || !safeValue(parsed.refreshToken)) return false;
    if (value.contains("token_type") && toLower(stringField(value, "token_type")) != "bearer") return false;
    const auto accessClaims = claims(parsed.accessToken);
    const auto idAccount = account(claims(stringField(value, "id_token")));
    const auto accessAccount = account(accessClaims);
    if (!idAccount.empty() && !accessAccount.empty() && idAccount != accessAccount) return false;
    parsed.accountId = !accessAccount.empty() ? accessAccount : !idAccount.empty() ? idAccount : previous.accountId;
    if (!safeValue(parsed.accountId, 256) || (!previous.accountId.empty() && previous.accountId != parsed.accountId)) return false;
    const auto expires = value.find("expires_in");
    if (expires != value.end()) {
        if (!expires->is_number_integer()) return false;
        const double seconds = expires->get<double>();
        if (seconds <= 30 || seconds > 31536000) return false;
        parsed.expiresAtMs = now + static_cast<long long>(seconds) * 1000;
    }
    const auto exp = accessClaims.find("exp");
    if (exp != accessClaims.end()) {
        if (!exp->is_number_integer()) return false;
        const double seconds = exp->get<double>();
        if (seconds <= 0 || seconds > 100000000000.0) return false;
        const auto jwtExpiry = static_cast<long long>(seconds) * 1000;
        parsed.expiresAtMs = parsed.expiresAtMs ? std::min(parsed.expiresAtMs, jwtExpiry) : jwtExpiry;
    }
    if (parsed.expiresAtMs <= now + 30000) return false;
    out = std::move(parsed);
    return true;
}

std::string chatGptAuthorizationUrl(const std::string& state, const std::string& challenge) {
    return "https://auth.openai.com/oauth/authorize?response_type=code&client_id=" + std::string(kChatGptClientId) +
        "&redirect_uri=" + encode(kRedirect) + "&scope=" + encode("openid profile email offline_access") +
        "&code_challenge_method=S256&code_challenge=" + encode(challenge) + "&state=" + encode(state) +
        "&id_token_add_organizations=true&codex_cli_simplified_flow=true";
}

bool parseChatGptCallback(std::string_view target, std::string_view state, std::string& code, std::string& error) {
    code.clear(); error.clear();
    if (!target.starts_with("/auth/callback?") || target.size() > 16384 || target.find('#') != std::string_view::npos) return false;
    std::map<std::string, std::string> params;
    target.remove_prefix(15);
    while (!target.empty()) {
        const auto separator = target.find('&');
        const auto pair = target.substr(0, separator);
        const auto equals = pair.find('=');
        std::string key, value;
        if (equals == std::string_view::npos || !decode(pair.substr(0, equals), key) || !decode(pair.substr(equals + 1), value) ||
            !params.emplace(key, value).second) return false;
        if (separator == std::string_view::npos) break;
        target.remove_prefix(separator + 1);
    }
    if (state.empty() || params["state"] != state) return false;
    if (params.contains("error")) {
        error = params["error"] == "access_denied" ? "ChatGPT sign-in was denied. Check Codex access for your account and reconnect." :
            "ChatGPT sign-in failed. Reconnect to try again.";
        return true;
    }
    if (!safeValue(params["code"], 8192)) return false;
    code = params["code"];
    return true;
}

bool appendChatGptHeaders(std::string_view model, const std::string& origin, const ChatGptTokens& tokens,
                         HttpHeaders& headers, std::string& error) {
    if (model != kChatGptModel) return true;
    if (!isSafeApiUrl(origin, error)) return false;
    if (!safeValue(tokens.accessToken) || !safeValue(tokens.accountId, 256) || tokens.expiresAtMs <= nowMs() + 30000) {
        error = kNeeded; return false;
    }
    headers.emplace_back("x-darkcode-openai-oauth-token", tokens.accessToken);
    headers.emplace_back("x-darkcode-openai-account-id", tokens.accountId);
    return true;
}

ChatGptAuth::ChatGptAuth() : path_(darkcodeDir() + "/desktop-chatgpt.dpapi") {
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(toWide(darkcodeDir())), ec);
    // Keep one desktop owner of the rotating refresh token across processes.
    const auto lock = ::CreateFileW(toWide(path_ + ".lock").c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
        OPEN_ALWAYS, FILE_ATTRIBUTE_HIDDEN, nullptr);
    if (lock == INVALID_HANDLE_VALUE) { error_ = "ChatGPT credentials are unavailable or in use by another desktop window."; return; }
    storeLock_ = lock;
    std::ifstream file(std::filesystem::path(toWide(path_)), std::ios::binary);
    if (!file) return;
    std::string encrypted(65537, '\0');
    file.read(encrypted.data(), static_cast<std::streamsize>(encrypted.size()));
    encrypted.resize(static_cast<size_t>(file.gcount()));
    DATA_BLOB input{static_cast<DWORD>(encrypted.size()), reinterpret_cast<BYTE*>(encrypted.data())}, output{};
    if (encrypted.empty() || encrypted.size() > 65536 || !::CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr,
        CRYPTPROTECT_UI_FORBIDDEN, &output)) { error_ = "Cannot decrypt ChatGPT credentials. Reconnect to replace them."; return; }
    auto value = json::parse(output.pbData, output.pbData + output.cbData, nullptr, false);
    ::SecureZeroMemory(output.pbData, output.cbData); ::LocalFree(output.pbData);
    if (value.is_object()) {
        tokens_.accessToken = stringField(value, "accessToken");
        tokens_.refreshToken = stringField(value, "refreshToken");
        tokens_.accountId = stringField(value, "accountId");
        const auto expires = value.find("expiresAtMs");
        if (expires != value.end() && expires->is_number_integer() && expires->get<double>() > 0 && expires->get<double>() < 1e14)
            tokens_.expiresAtMs = expires->get<long long>();
    }
    if (!safeValue(tokens_.accessToken) || !safeValue(tokens_.refreshToken) || !safeValue(tokens_.accountId, 256) || !tokens_.expiresAtMs) {
        tokens_ = {}; error_ = "Invalid ChatGPT credential store. Reconnect to replace it.";
    }
}

ChatGptAuth::~ChatGptAuth() {
    shutdown();
    if (storeLock_) ::CloseHandle(storeLock_);
}

bool ChatGptAuth::save(const ChatGptTokens& tokens) {
    if (!storeLock_) return false;
    std::string raw = json{{"accessToken", tokens.accessToken}, {"refreshToken", tokens.refreshToken},
        {"accountId", tokens.accountId}, {"expiresAtMs", tokens.expiresAtMs}}.dump();
    DATA_BLOB input{static_cast<DWORD>(raw.size()), reinterpret_cast<BYTE*>(raw.data())}, output{};
    const bool protectedOk = ::CryptProtectData(&input, L"DarkCode Desktop ChatGPT", nullptr, nullptr, nullptr,
        CRYPTPROTECT_UI_FORBIDDEN, &output) != FALSE;
    ::SecureZeroMemory(raw.data(), raw.size());
    if (!protectedOk) return false;
    const auto temp = toWide(path_ + ".tmp");
    std::ofstream file(std::filesystem::path(temp), std::ios::binary | std::ios::trunc);
    file.write(reinterpret_cast<const char*>(output.pbData), output.cbData);
    file.flush();
    bool ok = file.good();
    file.close();
    ok = ok && !file.fail();
    ::LocalFree(output.pbData);
    if (ok) ok = ::MoveFileExW(temp.c_str(), toWide(path_).c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
    if (!ok) ::DeleteFileW(temp.c_str());
    return ok;
}

bool ChatGptAuth::erase() {
    return storeLock_ && (::DeleteFileW(toWide(path_).c_str()) || ::GetLastError() == ERROR_FILE_NOT_FOUND);
}

ChatGptStatus ChatGptAuth::status() {
    std::lock_guard lock(mutex_);
    const bool fresh = tokens_.expiresAtMs > nowMs() + 30000;
    const bool available = !stopped_ && !connecting_ && !tokens_.accessToken.empty() && (fresh || !tokens_.refreshToken.empty());
    return {connecting_ || refreshing_, available, fresh && !tokens_.accessToken.empty(), connecting_,
        connecting_ ? "Waiting for browser" : refreshing_ ? "Refreshing" : tokens_.accessToken.empty() ? "Not connected" :
        fresh ? "Connected" : tokens_.refreshToken.empty() ? "Reconnect required" : "Expired - refresh before use", error_};
}

void ChatGptAuth::connect() {
    {
        std::lock_guard lock(mutex_);
        if (connecting_ || refreshing_ || stopped_ || !storeLock_) return;
    }
    if (loginThread_.joinable()) loginThread_.join();
    std::lock_guard lock(mutex_);
    if (refreshing_ || stopped_) return;
    connecting_ = true; cancelLogin_ = false; error_.clear();
    const auto generation = ++generation_;
    loginThread_ = std::thread([this, generation] {
        ChatGptTokens tokens;
        std::string error = "ChatGPT sign-in failed. Reconnect to try again.";
        bool ok = false;
        try { ok = browserLogin(cancelLogin_, tokens, error); } catch (...) { /* never expose token-bearing exceptions */ }
        std::lock_guard guard(mutex_);
        connecting_ = false;
        if (generation != generation_ || cancelLogin_ || stopped_) return;
        if (ok && save(tokens)) { tokens_ = std::move(tokens); error_.clear(); }
        else error_ = ok ? "Could not save protected ChatGPT credentials. Reconnect to try again." : error;
    });
}

void ChatGptAuth::cancel() {
    std::lock_guard lock(mutex_);
    if (!connecting_) return;
    cancelLogin_ = true;
    ++generation_;
    error_ = "ChatGPT sign-in cancelled.";
}

void ChatGptAuth::disconnect() {
    cancelLogin_ = true;
    std::lock_guard lock(mutex_);
    ++generation_; tokens_ = {};
    error_ = erase() ? "" : "Disconnected in this window, but the protected store could not be removed. Close other desktop windows and retry.";
    cv_.notify_all();
}

void ChatGptAuth::shutdown() {
    stopped_ = true; cancelLogin_ = true;
    {
        std::lock_guard lock(mutex_);
        ++generation_;
    }
    cv_.notify_all();
    if (loginThread_.joinable()) loginThread_.join();
    std::unique_lock lock(mutex_);
    cv_.wait(lock, [&] { return !refreshing_; });
}

bool ChatGptAuth::requestHeaders(std::string_view model, const std::string& origin, HttpHeaders& headers,
                               std::string& error, const CancelCheck& cancelled) {
    if (model != kChatGptModel) return true;
    if (!isSafeApiUrl(origin, error)) return false;
    std::unique_lock lock(mutex_);
    const auto generation = generation_;
    auto invalid = [&] { return stopped_ || generation != generation_ || (cancelled && cancelled()); };
    while (refreshing_ && !invalid()) cv_.wait_for(lock, std::chrono::milliseconds(50));
    if (invalid() || connecting_ || tokens_.accessToken.empty()) { error = kNeeded; return false; }
    if (tokens_.expiresAtMs <= nowMs() + 30000) {
        if (tokens_.refreshToken.empty()) { error = kNeeded; return false; }
        refreshing_ = true;
        const auto previous = tokens_;
        lock.unlock();
        HttpResult result;
        ChatGptTokens updated;
        bool ok = false;
        try {
            result = tokenRequest("grant_type=refresh_token&client_id=" + std::string(kChatGptClientId) +
                "&refresh_token=" + encode(previous.refreshToken), [&] {
                    std::lock_guard guard(mutex_); return stopped_ || generation != generation_;
                });
            ok = result.ok() && parseChatGptTokens(json::parse(result.body, nullptr, false), previous, updated, nowMs());
        } catch (...) { /* sanitized below */ }
        lock.lock();
        if (generation == generation_ && !stopped_) {
            if (ok && save(updated)) { tokens_ = std::move(updated); error_.clear(); }
            else {
                // A failed/ambiguous rotation must not replay an old refresh token.
                tokens_ = {}; erase();
                error_ = "ChatGPT refresh failed. Reconnect in Settings > Models; no fallback was used.";
            }
        }
        refreshing_ = false; cv_.notify_all();
    }
    if (invalid()) { error = kNeeded; return false; }
    if (tokens_.accessToken.empty()) { error = error_.empty() ? kNeeded : error_; return false; }
    return appendChatGptHeaders(model, origin, tokens_, headers, error);
}

} // namespace dc
