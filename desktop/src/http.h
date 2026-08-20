// Minimal WinHTTP client. Synchronous by design — every call runs on a worker
// thread, never the UI thread.
#pragma once

#include <functional>
#include <string>
#include <utility>
#include <vector>

namespace dc {

using HttpHeaders = std::vector<std::pair<std::string, std::string>>;

struct HttpResult {
    long status = 0;
    std::string body;   // full body, or the error body of a failed stream
    std::string error;  // transport-level failure; empty when the request completed
    bool aborted = false;

    bool ok() const { return error.empty() && status >= 200 && status < 300; }
};

/// Return false from the sink to abort the transfer (used by the Stop button).
using StreamSink = std::function<bool(const char* data, size_t length)>;

HttpResult httpRequest(const std::string& method,
                       const std::string& url,
                       const HttpHeaders& headers,
                       const std::string& body,
                       int timeoutMs = 60000);

/// Streams a 2xx response body through `sink` as it arrives. A non-2xx status
/// is read whole into `HttpResult::body` instead, so callers can surface the
/// server's JSON error.
HttpResult httpStream(const std::string& method,
                      const std::string& url,
                      const HttpHeaders& headers,
                      const std::string& body,
                      const StreamSink& sink);

struct HttpFetchResult {
    long status = 0;
    std::string body;
    std::string error;
    /// True when `maxBytes` cut the read short.
    bool truncated = false;
    std::string contentType;
    std::string location;
};

/// A single GET hop for `webFetch`.
///
/// Redirects are deliberately NOT followed: the caller walks them by hand so
/// the permission policy is re-checked at every new host. WinHTTP's automatic
/// handling would let an approved host bounce the request to a denied one with
/// no second check.
///
/// The body is capped at `maxBytes` as it arrives, not by Content-Length —
/// that header is a claim, not a guarantee, and a server can advertise 1KB then
/// send gigabytes.
HttpFetchResult httpFetchOnce(const std::string& url,
                              const HttpHeaders& headers,
                              int timeoutMs,
                              size_t maxBytes);

} // namespace dc
