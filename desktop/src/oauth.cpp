#include "oauth.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>

#include <array>
#include <chrono>
#include <cctype>
#include <memory>
#include <string_view>
#include <vector>

#include "http.h"
#include "json.h"
#include "util.h"

namespace dc {
namespace {

constexpr auto kLoginTimeout = std::chrono::minutes(5);
constexpr size_t kMaxCallbackRequestBytes = 16 * 1024;

struct SocketCloser {
    void operator()(SOCKET* socket) const noexcept {
        if (socket) {
            if (*socket != INVALID_SOCKET) ::closesocket(*socket);
            delete socket;
        }
    }
};
using SocketHandle = std::unique_ptr<SOCKET, SocketCloser>;

SocketHandle makeSocket(SOCKET value) {
    return SocketHandle(new SOCKET(value));
}

class WinsockSession {
public:
    WinsockSession() {
        WSADATA data{};
        ready_ = ::WSAStartup(MAKEWORD(2, 2), &data) == 0;
    }
    ~WinsockSession() {
        if (ready_) ::WSACleanup();
    }
    WinsockSession(const WinsockSession&) = delete;
    WinsockSession& operator=(const WinsockSession&) = delete;
    bool ready() const { return ready_; }

private:
    bool ready_ = false;
};

std::string windowsError(const char* action, int code = ::WSAGetLastError()) {
    return std::string(action) + " failed (Windows error " + std::to_string(code) + ")";
}

std::vector<unsigned char> secureRandom(size_t length) {
    std::vector<unsigned char> bytes(length);
    if (::BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                          BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
        return {};
    }
    return bytes;
}

std::vector<unsigned char> sha256(std::string_view value) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    DWORD objectLength = 0;
    DWORD hashLength = 0;
    DWORD received = 0;

    if (::BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return {};
    const auto closeAlgorithm = [&] { ::BCryptCloseAlgorithmProvider(algorithm, 0); };

    if (::BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                            reinterpret_cast<PUCHAR>(&objectLength), sizeof(objectLength),
                            &received, 0) < 0 ||
        ::BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
                            reinterpret_cast<PUCHAR>(&hashLength), sizeof(hashLength),
                            &received, 0) < 0) {
        closeAlgorithm();
        return {};
    }

    std::vector<unsigned char> object(objectLength);
    std::vector<unsigned char> digest(hashLength);
    if (::BCryptCreateHash(algorithm, &hash, object.data(), objectLength, nullptr, 0, 0) < 0) {
        closeAlgorithm();
        return {};
    }

    const NTSTATUS hashStatus = ::BCryptHashData(
        hash, reinterpret_cast<PUCHAR>(const_cast<char*>(value.data())),
        static_cast<ULONG>(value.size()), 0);
    const NTSTATUS finishStatus = hashStatus < 0
                                      ? hashStatus
                                      : ::BCryptFinishHash(hash, digest.data(), hashLength, 0);
    ::BCryptDestroyHash(hash);
    closeAlgorithm();
    return finishStatus < 0 ? std::vector<unsigned char>{} : digest;
}

std::string percentEncode(std::string_view value) {
    static constexpr char kHex[] = "0123456789ABCDEF";
    std::string out;
    out.reserve(value.size() * 3);
    for (const unsigned char c : value) {
        if (std::isalnum(c) != 0 || c == '-' || c == '_' || c == '.' || c == '~') {
            out.push_back(static_cast<char>(c));
        } else {
            out.push_back('%');
            out.push_back(kHex[c >> 4]);
            out.push_back(kHex[c & 0x0F]);
        }
    }
    return out;
}

int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

bool percentDecode(std::string_view value, std::string& out) {
    out.clear();
    out.reserve(value.size());
    for (size_t i = 0; i < value.size(); ++i) {
        if (value[i] == '+') {
            out.push_back(' ');
        } else if (value[i] == '%') {
            if (i + 2 >= value.size()) return false;
            const int high = hexValue(value[i + 1]);
            const int low = hexValue(value[i + 2]);
            if (high < 0 || low < 0) return false;
            out.push_back(static_cast<char>((high << 4) | low));
            i += 2;
        } else {
            out.push_back(value[i]);
        }
    }
    return true;
}

std::string queryValue(std::string_view target, std::string_view name) {
    const size_t queryStart = target.find('?');
    if (queryStart == std::string_view::npos) return {};
    std::string_view query = target.substr(queryStart + 1);
    while (!query.empty()) {
        const size_t separator = query.find('&');
        const std::string_view pair = query.substr(0, separator);
        const size_t equals = pair.find('=');
        const std::string_view key = pair.substr(0, equals);
        if (key == name) {
            std::string decoded;
            if (!percentDecode(equals == std::string_view::npos ? std::string_view{}
                                                                 : pair.substr(equals + 1),
                               decoded)) {
                return {};
            }
            return decoded;
        }
        if (separator == std::string_view::npos) break;
        query.remove_prefix(separator + 1);
    }
    return {};
}

std::string envValue(const wchar_t* name) {
    std::array<wchar_t, 2048> buffer{};
    const DWORD length = ::GetEnvironmentVariableW(name, buffer.data(),
                                                    static_cast<DWORD>(buffer.size()));
    if (length == 0 || length >= buffer.size()) return {};
    return toUtf8(std::wstring_view(buffer.data(), length));
}

std::string withoutTrailingSlash(std::string value) {
    while (!value.empty() && value.back() == '/') value.pop_back();
    return value;
}

struct OAuthConfig {
    std::string frontendApi;
    std::string clientId;
};

bool loadOAuthConfig(const std::string& apiUrl, OAuthConfig& config, std::string& error) {
    const std::string envFrontend = envValue(L"CLERK_FRONTEND_API");
    const std::string envClient = envValue(L"CLERK_OAUTH_CLIENT_ID");
    if (!envFrontend.empty() && !envClient.empty()) {
        config.frontendApi = withoutTrailingSlash(envFrontend);
        config.clientId = envClient;
        if (!isSafeApiUrl(config.frontendApi, error)) {
            error = "The identity provider URL is unsafe: " + error;
            return false;
        }
        return true;
    }

    HttpHeaders headers{{"Accept", "application/json"}};
    const HttpResult result = httpRequest("GET", apiUrl + "/auth/config", headers, {}, 30000, false);
    if (!result.ok()) {
        error = result.error.empty()
                    ? "Could not load sign-in configuration (HTTP " + std::to_string(result.status) + ")."
                    : result.error;
        return false;
    }

    const json parsed = json::parse(result.body, nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object()) {
        error = "The sign-in configuration response was not valid JSON.";
        return false;
    }
    config.frontendApi = withoutTrailingSlash(parsed.value("clerkFrontendApi", std::string()));
    config.clientId = parsed.value("clientId", std::string());
    if (config.frontendApi.empty() || config.clientId.empty()) {
        error = "Sign-in is not configured correctly on the DarkCode API.";
        return false;
    }
    if (!isSafeApiUrl(config.frontendApi, error)) {
        error = "The identity provider URL is unsafe: " + error;
        return false;
    }
    return true;
}

bool sendHttpResponse(SOCKET socket, int status, std::string_view message) {
    const std::string reason = status == 200 ? "OK" : status == 404 ? "Not Found" : "Bad Request";
    const std::string body = std::string(message) + "\r\n";
    const std::string response = "HTTP/1.1 " + std::to_string(status) + " " + reason +
                                 "\r\nContent-Type: text/plain; charset=utf-8\r\n"
                                 "Cache-Control: no-store\r\nConnection: close\r\nContent-Length: " +
                                 std::to_string(body.size()) + "\r\n\r\n" + body;
    return ::send(socket, response.data(), static_cast<int>(response.size()), 0) != SOCKET_ERROR;
}

struct CallbackRequest {
    SocketHandle socket;
    std::string code;
    std::string state;
    std::string error;
};

CallbackRequest waitForCallback(SOCKET listener,
                                const std::atomic<bool>& cancelled,
                                std::chrono::steady_clock::time_point deadline,
                                unsigned short expectedPort,
                                const std::string& expectedNonce) {
    while (!cancelled.load() && std::chrono::steady_clock::now() < deadline) {
        fd_set readSet;
        FD_ZERO(&readSet);
        FD_SET(listener, &readSet);
        timeval timeout{0, 100'000};
        const int selected = ::select(0, &readSet, nullptr, nullptr, &timeout);
        if (selected == SOCKET_ERROR) return {{}, {}, {}, windowsError("Waiting for sign-in callback")};
        if (selected == 0) continue;

        SocketHandle client = makeSocket(::accept(listener, nullptr, nullptr));
        if (*client == INVALID_SOCKET) continue;

        DWORD receiveTimeout = 3000;
        ::setsockopt(*client, SOL_SOCKET, SO_RCVTIMEO,
                     reinterpret_cast<const char*>(&receiveTimeout), sizeof(receiveTimeout));

        std::string request;
        std::array<char, 2048> buffer{};
        while (request.size() < kMaxCallbackRequestBytes && request.find("\r\n\r\n") == std::string::npos) {
            const int received = ::recv(*client, buffer.data(), static_cast<int>(buffer.size()), 0);
            if (received <= 0) break;
            request.append(buffer.data(), static_cast<size_t>(received));
        }

        const size_t lineEnd = request.find("\r\n");
        const std::string_view line(request.data(), lineEnd == std::string::npos ? request.size() : lineEnd);
        const size_t firstSpace = line.find(' ');
        const size_t secondSpace = firstSpace == std::string_view::npos
                                       ? std::string_view::npos
                                       : line.find(' ', firstSpace + 1);
        if (!startsWith(line, "GET ") || secondSpace == std::string_view::npos) {
            sendHttpResponse(*client, 400, "Invalid sign-in callback.");
            continue;
        }

        const std::string_view target = line.substr(firstSpace + 1, secondSpace - firstSpace - 1);
        const size_t queryStart = target.find('?');
        if (target.substr(0, queryStart) != "/callback") {
            sendHttpResponse(*client, 404, "Not found.");
            continue;
        }

        const std::string code = queryValue(target, "code");
        const std::string state = queryValue(target, "state");
        const std::string oauthError = queryValue(target, "error");
        if (state.empty() || (code.empty() && oauthError.empty())) {
            sendHttpResponse(*client, 400, "Missing authorization result or state.");
            continue;
        }

        unsigned short callbackPort = 0;
        std::string callbackNonce;
        std::string stateError;
        if (!decodeOAuthState(state, callbackPort, callbackNonce, stateError) ||
            callbackPort != expectedPort || callbackNonce != expectedNonce) {
            sendHttpResponse(*client, 400, "Invalid sign-in state.");
            continue;
        }

        if (!oauthError.empty()) {
            const std::string description = queryValue(target, "error_description");
            sendHttpResponse(*client, 400, "Authentication failed. Return to DarkCode and try again.");
            return {std::move(client), {}, state, description.empty() ? oauthError : description};
        }
        return {std::move(client), code, state, {}};
    }

    return {{}, {}, {}, cancelled.load() ? "Sign-in was cancelled." : "Sign-in timed out. Please try again."};
}

OAuthResult exchangeCode(const OAuthConfig& config,
                         const std::string& apiUrl,
                         const std::string& code,
                         const std::string& verifier) {
    const std::string redirectUri = apiUrl + "/auth/callback";
    const std::string form = "grant_type=authorization_code&code=" + percentEncode(code) +
                             "&redirect_uri=" + percentEncode(redirectUri) +
                             "&client_id=" + percentEncode(config.clientId) +
                             "&code_verifier=" + percentEncode(verifier);
    const HttpHeaders headers{{"Content-Type", "application/x-www-form-urlencoded"},
                              {"Accept", "application/json"}};
    const HttpResult result = httpRequest("POST", config.frontendApi + "/oauth/token", headers,
                                          form, 30000, false);
    if (!result.ok()) {
        return {{}, result.body.empty() ? (result.error.empty() ? "Could not complete sign-in." : result.error)
                                             : "The identity provider rejected the sign-in request."};
    }

    const json parsed = json::parse(result.body, nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object()) {
        return {{}, "The identity provider returned an invalid response."};
    }

    AuthData auth;
    auth.token = parsed.value("access_token", std::string());
    auth.refreshToken = parsed.value("refresh_token", std::string());
    if (parsed.contains("expires_in") && parsed["expires_in"].is_number()) {
        auth.expiresAtMs = nowMs() + parsed["expires_in"].get<long long>() * 1000;
    }
    if (!auth.valid()) return {{}, "The sign-in response did not include an access token."};
    return {std::move(auth), {}};
}

std::vector<unsigned char> base64UrlDecode(std::string_view value) {
    std::array<int, 256> table{};
    table.fill(-1);
    constexpr std::string_view alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (size_t i = 0; i < alphabet.size(); ++i) {
        table[static_cast<unsigned char>(alphabet[i])] = static_cast<int>(i);
    }

    std::vector<unsigned char> out;
    unsigned int accumulator = 0;
    int bits = -8;
    for (const unsigned char c : value) {
        const int decoded = table[c];
        if (decoded < 0) return {};
        accumulator = (accumulator << 6) | decoded;
        bits += 6;
        if (bits >= 0) {
            out.push_back(static_cast<unsigned char>((accumulator >> bits) & 0xFF));
            bits -= 8;
        }
    }
    return out;
}

} // namespace

std::string base64UrlEncode(const unsigned char* data, size_t length) {
    static constexpr char kAlphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string out;
    out.reserve((length * 4 + 2) / 3);
    unsigned int accumulator = 0;
    int bits = -6;
    for (size_t i = 0; i < length; ++i) {
        accumulator = (accumulator << 8) | data[i];
        bits += 8;
        while (bits >= 0) {
            out.push_back(kAlphabet[(accumulator >> bits) & 0x3F]);
            bits -= 6;
        }
    }
    if (bits > -6) out.push_back(kAlphabet[(accumulator << 8 >> (bits + 8)) & 0x3F]);
    return out;
}

std::string encodeOAuthState(unsigned short port, const std::string& nonce) {
    json payload = json::object();
    payload["port"] = port;
    payload["nonce"] = nonce;
    const std::string raw = payload.dump();
    return base64UrlEncode(reinterpret_cast<const unsigned char*>(raw.data()), raw.size());
}

bool decodeOAuthState(const std::string& state,
                      unsigned short& port,
                      std::string& nonce,
                      std::string& error) {
    const std::string_view encoded = std::string_view(state).substr(0, state.find('.'));
    const std::vector<unsigned char> bytes = base64UrlDecode(encoded);
    if (bytes.empty()) {
        error = "The sign-in state was not valid.";
        return false;
    }
    const json payload = json::parse(std::string(bytes.begin(), bytes.end()), nullptr, false);
    if (payload.is_discarded() || !payload.is_object() ||
        !payload.contains("port") || !payload["port"].is_number_unsigned() ||
        !payload.contains("nonce") || !payload["nonce"].is_string()) {
        error = "The sign-in state was not valid.";
        return false;
    }
    const unsigned int decodedPort = payload["port"].get<unsigned int>();
    if (decodedPort == 0 || decodedPort > 65535) {
        error = "The sign-in callback port was not valid.";
        return false;
    }
    port = static_cast<unsigned short>(decodedPort);
    nonce = payload["nonce"].get<std::string>();
    if (nonce.empty()) {
        error = "The sign-in nonce was missing.";
        return false;
    }
    return true;
}

std::string buildAuthorizationUrl(const std::string& clerkFrontendApi,
                                  const std::string& clientId,
                                  const std::string& apiUrl,
                                  const std::string& state,
                                  const std::string& challenge) {
    return withoutTrailingSlash(clerkFrontendApi) + "/oauth/authorize?response_type=code&client_id=" +
           percentEncode(clientId) + "&redirect_uri=" + percentEncode(apiUrl + "/auth/callback") +
           "&scope=" + percentEncode("openid email profile offline_access") +
           "&state=" + percentEncode(state) + "&prompt=login&code_challenge=" +
           percentEncode(challenge) + "&code_challenge_method=S256";
}

OAuthResult signInWithBrowser(const std::string& apiUrl,
                              const std::atomic<bool>& cancelled,
                              const OAuthStatusSink& statusSink) {
    std::string originError;
    if (!isSafeApiUrl(apiUrl, originError)) return {{}, originError};

    if (statusSink) statusSink("Loading sign-in configuration...");
    OAuthConfig config;
    std::string error;
    if (!loadOAuthConfig(apiUrl, config, error)) return {{}, error};
    if (cancelled.load()) return {{}, "Sign-in was cancelled."};

    const std::vector<unsigned char> verifierBytes = secureRandom(32);
    const std::vector<unsigned char> nonceBytes = secureRandom(16);
    if (verifierBytes.empty() || nonceBytes.empty()) {
        return {{}, "Windows could not generate secure sign-in data."};
    }
    const std::string verifier = base64UrlEncode(verifierBytes.data(), verifierBytes.size());
    const std::vector<unsigned char> digest = sha256(verifier);
    if (digest.empty()) return {{}, "Windows could not create the PKCE challenge."};
    const std::string challenge = base64UrlEncode(digest.data(), digest.size());
    const std::string nonce = base64UrlEncode(nonceBytes.data(), nonceBytes.size());

    WinsockSession winsock;
    if (!winsock.ready()) return {{}, windowsError("Starting the sign-in listener")};
    SocketHandle listener = makeSocket(::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
    if (*listener == INVALID_SOCKET) return {{}, windowsError("Creating the sign-in listener")};

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = 0;
    BOOL exclusive = TRUE;
    if (::setsockopt(*listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
                     reinterpret_cast<const char*>(&exclusive), sizeof(exclusive)) == SOCKET_ERROR) {
        return {{}, windowsError("Securing the sign-in listener")};
    }
    if (::bind(*listener, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR ||
        ::listen(*listener, SOMAXCONN) == SOCKET_ERROR) {
        return {{}, windowsError("Binding the sign-in listener")};
    }

    int addressLength = sizeof(address);
    if (::getsockname(*listener, reinterpret_cast<sockaddr*>(&address), &addressLength) == SOCKET_ERROR) {
        return {{}, windowsError("Reading the sign-in listener address")};
    }
    const unsigned short port = ntohs(address.sin_port);
    const std::string state = encodeOAuthState(port, nonce);
    const std::string authorizationUrl =
        buildAuthorizationUrl(config.frontendApi, config.clientId, apiUrl, state, challenge);

    if (statusSink) statusSink("Waiting for sign-in in your browser...");
    const HINSTANCE opened = ::ShellExecuteW(nullptr, L"open", toWide(authorizationUrl).c_str(),
                                             nullptr, nullptr, SW_SHOWNORMAL);
    if (reinterpret_cast<INT_PTR>(opened) <= 32) {
        return {{}, "DarkCode could not open your browser. Check your Windows default browser setting."};
    }

    CallbackRequest callback = waitForCallback(*listener, cancelled,
                                                std::chrono::steady_clock::now() + kLoginTimeout,
                                                port, nonce);
    if (!callback.error.empty()) return {{}, callback.error};

    unsigned short callbackPort = 0;
    std::string callbackNonce;
    if (!decodeOAuthState(callback.state, callbackPort, callbackNonce, error) ||
        callbackPort != port || callbackNonce != nonce) {
        sendHttpResponse(*callback.socket, 400, "Invalid sign-in state.");
        return {{}, error.empty() ? "The sign-in state did not match. Please try again." : error};
    }
    if (cancelled.load()) {
        sendHttpResponse(*callback.socket, 400, "Sign-in was cancelled.");
        return {{}, "Sign-in was cancelled."};
    }

    if (statusSink) statusSink("Completing sign-in...");
    OAuthResult result = exchangeCode(config, apiUrl, callback.code, verifier);
    if (!result.ok()) {
        sendHttpResponse(*callback.socket, 400, "Authentication failed. Return to DarkCode and try again.");
        return result;
    }

    sendHttpResponse(*callback.socket, 200, "Authenticated. You can return to DarkCode and close this tab.");
    return result;
}

} // namespace dc
