#include "web.h"

#include <algorithm>

#include "html.h"
#include "http.h"
#include "util.h"

namespace dc {
namespace {

bool containsToken(const std::string& contentType, const std::string& token) {
    return contentType.find(token) != std::string::npos;
}

/// The subset of the content type before any ";charset=..." parameter.
std::string essence(const std::string& contentType) {
    const size_t semicolon = contentType.find(';');
    return trim(toLower(semicolon == std::string::npos ? contentType : contentType.substr(0, semicolon)));
}

} // namespace

ParsedFetchUrl parseFetchUrl(const std::string& raw) {
    ParsedFetchUrl out;
    const std::string url = trim(raw);
    if (url.empty()) {
        out.error = "Not a valid absolute URL: \"\"";
        return out;
    }

    const size_t schemeEnd = url.find("://");
    if (schemeEnd == std::string::npos || schemeEnd == 0) {
        // Name the alternative rather than just refusing: a bare path is far
        // more likely a readFile than a malformed URL.
        const size_t colon = url.find(':');
        if (colon != std::string::npos && colon < url.find('/')) {
            const std::string scheme = toLower(url.substr(0, colon));
            out.error = "Only http and https URLs can be fetched (got \"" + scheme +
                        "\"). Use readFile for local files.";
            return out;
        }
        out.error = "Not a valid absolute URL: \"" + url + "\"";
        return out;
    }

    out.scheme = toLower(url.substr(0, schemeEnd));
    if (out.scheme != "http" && out.scheme != "https") {
        out.error = "Only http and https URLs can be fetched (got \"" + out.scheme +
                    "\"). Use readFile for local files.";
        return out;
    }

    const size_t hostStart = schemeEnd + 3;
    const size_t hostEnd = url.find_first_of("/?#", hostStart);
    out.host = toLower(url.substr(hostStart, hostEnd == std::string::npos ? std::string::npos
                                                                         : hostEnd - hostStart));
    // Credentials in the authority would make the host we check differ from the
    // host we display; strip them and judge the real destination.
    const size_t at = out.host.find('@');
    if (at != std::string::npos) out.host = out.host.substr(at + 1);

    if (out.host.empty()) {
        out.error = "Not a valid absolute URL: \"" + url + "\"";
        return out;
    }

    out.url = url;
    out.valid = true;
    return out;
}

bool isHtmlContentType(const std::string& contentType) {
    const std::string value = essence(contentType);
    return value == "text/html" || value == "application/xhtml+xml";
}

bool isJsonContentType(const std::string& contentType) {
    const std::string value = essence(contentType);
    return value == "application/json" ||
           (startsWith(value, "application/") && endsWith(value, "+json"));
}

bool isTextualContentType(const std::string& contentType) {
    const std::string value = essence(contentType);
    if (value.empty()) return true; // servers that omit the header, incl. dev servers
    if (startsWith(value, "text/")) return true;
    if (isJsonContentType(contentType)) return true;
    return value == "application/javascript" || value == "application/xml" ||
           value == "application/x-yaml" || value == "application/yaml" ||
           value == "application/x-sh" || value == "application/sql" ||
           value == "application/graphql";
}

WebFetchOutcome webFetch(const std::string& rawUrl,
                         const WebFetchOptions& options,
                         PermissionBroker& permissions,
                         bool autoApprove,
                         const std::function<bool()>& cancelled) {
    WebFetchOutcome outcome;

    const size_t maxChars = std::min(options.maxChars, kMaxCharsLimit);
    const int timeoutMs = std::min(options.timeoutMs, kMaxFetchTimeoutMs);
    const long long deadline = nowMs() + timeoutMs;

    ParsedFetchUrl current = parseFetchUrl(rawUrl);
    if (!current.valid) {
        outcome.error = current.error;
        return outcome;
    }

    HttpHeaders headers;
    // Identifying honestly is the right trade: a site that wants to block bots
    // should be able to block this one.
    headers.emplace_back("User-Agent", "DarkCode/1.0 (+https://darkcode.sh)");
    headers.emplace_back("Accept",
                         "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5");
    headers.emplace_back("Accept-Language", "en-US,en;q=0.9");

    std::vector<std::string> redirects;
    HttpFetchResult response;
    bool haveResponse = false;

    for (int hop = 0; hop <= kMaxRedirects; ++hop) {
        if (cancelled && cancelled()) {
            outcome.error = "Turn stopped";
            return outcome;
        }

        const long long remaining = deadline - nowMs();
        if (remaining <= 0) {
            outcome.error = "Timed out after " + std::to_string(timeoutMs) + "ms fetching " + rawUrl;
            return outcome;
        }

        // The policy check happens per hop, before the request is sent. The
        // first hop is the model's URL; later ones are the *server's* choice,
        // which is exactly why they cannot inherit the first hop's approval.
        const PermissionOutcome permitted = permissions.checkWeb(current.url, current.host, autoApprove);
        if (!permitted.allowed) {
            outcome.error = permitted.reason;
            return outcome;
        }

        response = httpFetchOnce(current.url, headers, static_cast<int>(remaining), kMaxFetchBytes);
        if (!response.error.empty()) {
            outcome.error = response.error;
            return outcome;
        }

        const bool isRedirect = response.status >= 300 && response.status < 400;
        if (!isRedirect || response.location.empty()) {
            haveResponse = true;
            break;
        }

        const std::string next = resolveUrl(current.url, response.location);
        ParsedFetchUrl parsedNext = parseFetchUrl(next.empty() ? response.location : next);
        if (!parsedNext.valid) {
            outcome.error = "Redirect to an unfetchable location (" + response.location + "): " +
                            parsedNext.error;
            return outcome;
        }
        redirects.push_back(parsedNext.url);
        current = parsedNext;
    }

    if (!haveResponse) {
        outcome.error = "Too many redirects (more than " + std::to_string(kMaxRedirects) +
                        ") starting from " + rawUrl + ". Last URL: " + current.url;
        return outcome;
    }

    if (!isTextualContentType(response.contentType)) {
        outcome.error = "Refusing to read binary content (content-type \"" + response.contentType +
                        "\") from " + current.url +
                        ". Only text, HTML, and JSON responses can be read.";
        return outcome;
    }

    const std::string& body = response.body;
    const std::string requested = options.format;

    std::string format;
    std::string content;
    std::string title;
    bool converterTruncated = false;

    const auto asText = [&]() {
        format = "text";
        content = body.size() > maxChars ? body.substr(0, maxChars) : body;
        converterTruncated = body.size() > maxChars;
    };

    if (requested == "text") {
        // An explicit `text` request means the model wants the raw source —
        // usually because it is reading markup or a template, not prose.
        asText();
    } else if (isHtmlContentType(response.contentType) && requested != "json") {
        format = "markdown";
        const MarkdownResult converted = htmlToMarkdown(body, current.url, maxChars);
        content = converted.markdown;
        title = converted.title;
        converterTruncated = converted.truncated;
    } else if (isJsonContentType(response.contentType) || requested == "json") {
        format = "json";
        const json parsed = json::parse(body, nullptr, false);
        if (parsed.is_discarded()) {
            // A JSON content-type on something that is not JSON is common
            // enough (error pages, proxies) that it should degrade, not fail.
            asText();
        } else {
            // Re-serialised rather than passed through: minified JSON is one
            // enormous line, which is unreadable and hostile to the
            // line-oriented way the model refers to everything else.
            const std::string pretty = parsed.dump(2);
            content = pretty.size() > maxChars ? pretty.substr(0, maxChars) : pretty;
            converterTruncated = pretty.size() > maxChars;
        }
    } else {
        asText();
    }

    json result = json::object();
    result["url"] = current.url;
    result["status"] = response.status;
    if (!response.contentType.empty()) result["contentType"] = response.contentType;
    if (!title.empty()) result["title"] = title;
    result["format"] = format;
    result["content"] = content;
    result["truncated"] = response.truncated || converterTruncated;
    if (!redirects.empty()) result["redirects"] = redirects;
    result["note"] = kUntrustedContentNote;

    outcome.ok = true;
    outcome.result = std::move(result);
    return outcome;
}

} // namespace dc
