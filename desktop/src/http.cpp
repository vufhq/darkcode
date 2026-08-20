#include "http.h"

#include <windows.h>
#include <winhttp.h>

#include <memory>

#include "util.h"

namespace dc {
namespace {

struct HandleDeleter {
    void operator()(HINTERNET handle) const noexcept {
        if (handle) ::WinHttpCloseHandle(handle);
    }
};
using Handle = std::unique_ptr<std::remove_pointer_t<HINTERNET>, HandleDeleter>;

std::string lastErrorMessage(const char* stage) {
    const DWORD code = ::GetLastError();
    return std::string(stage) + " failed (WinHTTP error " + std::to_string(code) + ")";
}

struct ParsedUrl {
    std::wstring host;
    std::wstring path;
    INTERNET_PORT port = 0;
    bool secure = false;
    bool valid = false;
};

ParsedUrl parseUrl(const std::string& url) {
    ParsedUrl parsed;
    const std::wstring wide = toWide(url);

    URL_COMPONENTS components{};
    components.dwStructSize = sizeof(components);
    components.dwSchemeLength = static_cast<DWORD>(-1);
    components.dwHostNameLength = static_cast<DWORD>(-1);
    components.dwUrlPathLength = static_cast<DWORD>(-1);
    components.dwExtraInfoLength = static_cast<DWORD>(-1);

    if (!::WinHttpCrackUrl(wide.c_str(), static_cast<DWORD>(wide.size()), 0, &components)) {
        return parsed;
    }

    parsed.host.assign(components.lpszHostName, components.dwHostNameLength);
    parsed.path.assign(components.lpszUrlPath, components.dwUrlPathLength);
    if (components.dwExtraInfoLength > 0) {
        parsed.path.append(components.lpszExtraInfo, components.dwExtraInfoLength);
    }
    if (parsed.path.empty()) parsed.path = L"/";
    parsed.port = components.nPort;
    parsed.secure = components.nScheme == INTERNET_SCHEME_HTTPS;
    parsed.valid = true;
    return parsed;
}

/// Opens the request and sends it. On success the caller owns the returned
/// handles and must keep `connect`/`session` alive while reading.
bool sendRequest(const std::string& method,
                 const ParsedUrl& parsed,
                 const HttpHeaders& headers,
                 const std::string& body,
                 int receiveTimeoutMs,
                 Handle& session,
                 Handle& connect,
                 Handle& request,
                 std::string& error) {
    session.reset(::WinHttpOpen(L"DarkCode-Desktop/1.0",
                                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                WINHTTP_NO_PROXY_NAME,
                                WINHTTP_NO_PROXY_BYPASS,
                                0));
    if (!session) {
        error = lastErrorMessage("WinHttpOpen");
        return false;
    }

    // Long receive timeout: a chat turn can think for a while before the first
    // token, and every read below blocks on it.
    ::WinHttpSetTimeouts(session.get(), 15000, 20000, 30000, receiveTimeoutMs);

    connect.reset(::WinHttpConnect(session.get(), parsed.host.c_str(), parsed.port, 0));
    if (!connect) {
        error = lastErrorMessage("WinHttpConnect");
        return false;
    }

    const DWORD flags = parsed.secure ? WINHTTP_FLAG_SECURE : 0;
    request.reset(::WinHttpOpenRequest(connect.get(),
                                       toWide(method).c_str(),
                                       parsed.path.c_str(),
                                       nullptr,
                                       WINHTTP_NO_REFERER,
                                       WINHTTP_DEFAULT_ACCEPT_TYPES,
                                       flags));
    if (!request) {
        error = lastErrorMessage("WinHttpOpenRequest");
        return false;
    }

    std::wstring headerBlock;
    for (const auto& [name, value] : headers) {
        if (name.empty() || value.empty()) continue;
        headerBlock += toWide(name) + L": " + toWide(value) + L"\r\n";
    }
    if (!headerBlock.empty()) {
        ::WinHttpAddRequestHeaders(request.get(),
                                   headerBlock.c_str(),
                                   static_cast<DWORD>(headerBlock.size()),
                                   WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);
    }

    const BOOL sent = ::WinHttpSendRequest(request.get(),
                                           WINHTTP_NO_ADDITIONAL_HEADERS,
                                           0,
                                           body.empty() ? WINHTTP_NO_REQUEST_DATA
                                                        : const_cast<char*>(body.data()),
                                           static_cast<DWORD>(body.size()),
                                           static_cast<DWORD>(body.size()),
                                           0);
    if (!sent) {
        error = lastErrorMessage("WinHttpSendRequest");
        return false;
    }
    if (!::WinHttpReceiveResponse(request.get(), nullptr)) {
        error = lastErrorMessage("WinHttpReceiveResponse");
        return false;
    }
    return true;
}

long queryStatus(HINTERNET request) {
    DWORD status = 0;
    DWORD size = sizeof(status);
    if (!::WinHttpQueryHeaders(request,
                               WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                               WINHTTP_HEADER_NAME_BY_INDEX,
                               &status,
                               &size,
                               WINHTTP_NO_HEADER_INDEX)) {
        return 0;
    }
    return static_cast<long>(status);
}

/// Drains the response. `sink` may be null, in which case everything is
/// appended to `body`.
bool readBody(HINTERNET request, const StreamSink* sink, std::string& body, bool& aborted, std::string& error) {
    std::string buffer;
    for (;;) {
        DWORD available = 0;
        if (!::WinHttpQueryDataAvailable(request, &available)) {
            error = lastErrorMessage("WinHttpQueryDataAvailable");
            return false;
        }
        if (available == 0) return true; // end of response

        buffer.resize(available);
        DWORD read = 0;
        if (!::WinHttpReadData(request, buffer.data(), available, &read)) {
            error = lastErrorMessage("WinHttpReadData");
            return false;
        }
        if (read == 0) return true;

        if (sink) {
            if (!(*sink)(buffer.data(), read)) {
                aborted = true;
                return true;
            }
        } else {
            body.append(buffer.data(), read);
        }
    }
}

} // namespace

HttpResult httpRequest(const std::string& method,
                       const std::string& url,
                       const HttpHeaders& headers,
                       const std::string& body,
                       int timeoutMs) {
    HttpResult result;

    const ParsedUrl parsed = parseUrl(url);
    if (!parsed.valid) {
        result.error = "Invalid URL: " + url;
        return result;
    }

    Handle session, connect, request;
    if (!sendRequest(method, parsed, headers, body, timeoutMs, session, connect, request, result.error)) {
        return result;
    }

    result.status = queryStatus(request.get());
    bool aborted = false;
    if (!readBody(request.get(), nullptr, result.body, aborted, result.error)) {
        return result;
    }
    return result;
}

HttpResult httpStream(const std::string& method,
                      const std::string& url,
                      const HttpHeaders& headers,
                      const std::string& body,
                      const StreamSink& sink) {
    HttpResult result;

    const ParsedUrl parsed = parseUrl(url);
    if (!parsed.valid) {
        result.error = "Invalid URL: " + url;
        return result;
    }

    Handle session, connect, request;
    // 5 minutes between reads: the gap before the first token on a slow model
    // plus any tool-call pause on the server side.
    if (!sendRequest(method, parsed, headers, body, 300000, session, connect, request, result.error)) {
        return result;
    }

    result.status = queryStatus(request.get());

    const bool streaming = result.status >= 200 && result.status < 300;
    bool aborted = false;
    readBody(request.get(), streaming ? &sink : nullptr, result.body, aborted, result.error);
    result.aborted = aborted;
    return result;
}

} // namespace dc
