// Small cross-cutting helpers: string/encoding conversion, glob matching, and
// the thread hop used to get worker results back onto the UI thread.
#pragma once

#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

namespace dc {

std::wstring toWide(std::string_view utf8);
std::string toUtf8(std::wstring_view wide);

std::string trim(std::string_view s);
bool startsWith(std::string_view s, std::string_view prefix);
bool endsWith(std::string_view s, std::string_view suffix);
std::string toLower(std::string_view s);

/// Splits on "\n" and "\r\n" alike. A CRLF file otherwise leaves a stray '\r'
/// on every line, which the model sees and copies back into edit payloads.
std::vector<std::string> splitLines(std::string_view text);
/// Strips a leading UTF-8 BOM.
std::string_view stripBom(std::string_view text);

std::string randomId(size_t length = 16);

/// Appends "... (truncated, N total chars)" past `limit`, like the CLI does.
std::string truncateForModel(const std::string& value, size_t limit);

/// Glob matcher covering the subset the model actually uses: `*`, `?`, `**`,
/// `{a,b}` alternation and `[abc]` classes. `*` never crosses a '/'.
bool globMatch(std::string_view pattern, std::string_view text);

std::string humanBytes(long long bytes);
std::string humanCount(long long value);

std::string localDateIso();      // YYYY-MM-DD in local time
std::string timezoneName();      // IANA-ish name, best effort
std::string osVersionString();

long long nowMs();

/// Runs callables submitted by worker threads on the UI thread.
class Dispatcher {
public:
    void post(std::function<void()> fn);
    void drain();

private:
    std::mutex mutex_;
    std::deque<std::function<void()>> queue_;
};

} // namespace dc
