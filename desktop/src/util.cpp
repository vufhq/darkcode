#include "util.h"

#include <windows.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <random>

namespace dc {

std::wstring toWide(std::string_view utf8) {
    if (utf8.empty()) return {};
    const int needed = ::MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(needed), L'\0');
    ::MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), needed);
    return out;
}

std::string toUtf8(std::wstring_view wide) {
    if (wide.empty()) return {};
    const int needed = ::WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<size_t>(needed), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), out.data(), needed, nullptr, nullptr);
    return out;
}

std::string trim(std::string_view s) {
    const auto notSpace = [](unsigned char c) { return std::isspace(c) == 0; };
    auto begin = std::find_if(s.begin(), s.end(), notSpace);
    auto end = std::find_if(s.rbegin(), s.rend(), notSpace).base();
    return begin < end ? std::string(begin, end) : std::string();
}

bool startsWith(std::string_view s, std::string_view prefix) {
    return s.size() >= prefix.size() && s.compare(0, prefix.size(), prefix) == 0;
}

bool endsWith(std::string_view s, std::string_view suffix) {
    return s.size() >= suffix.size() && s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

std::string toLower(std::string_view s) {
    std::string out(s);
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}

std::string_view stripBom(std::string_view text) {
    if (text.size() >= 3 && static_cast<unsigned char>(text[0]) == 0xEF &&
        static_cast<unsigned char>(text[1]) == 0xBB && static_cast<unsigned char>(text[2]) == 0xBF) {
        return text.substr(3);
    }
    return text;
}

std::vector<std::string> splitLines(std::string_view text) {
    std::vector<std::string> lines;
    std::string current;
    for (size_t i = 0; i < text.size(); ++i) {
        const char c = text[i];
        if (c == '\r') {
            if (i + 1 < text.size() && text[i + 1] == '\n') ++i;
            lines.push_back(current);
            current.clear();
        } else if (c == '\n') {
            lines.push_back(current);
            current.clear();
        } else {
            current.push_back(c);
        }
    }
    lines.push_back(current);
    return lines;
}

std::string randomId(size_t length) {
    static constexpr char kAlphabet[] = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    static thread_local std::mt19937_64 rng{std::random_device{}()};
    std::uniform_int_distribution<size_t> dist(0, sizeof(kAlphabet) - 2);
    std::string out;
    out.reserve(length);
    for (size_t i = 0; i < length; ++i) out.push_back(kAlphabet[dist(rng)]);
    return out;
}

std::string truncateForModel(const std::string& value, size_t limit) {
    if (value.size() <= limit) return value;
    return value.substr(0, limit) + "\n... (truncated, " + std::to_string(value.size()) + " total chars)";
}

namespace {

bool matchClass(std::string_view pattern, size_t& cursor, char c) {
    size_t i = cursor + 1; // pattern[cursor] == '['
    bool negate = false;
    if (i < pattern.size() && (pattern[i] == '!' || pattern[i] == '^')) {
        negate = true;
        ++i;
    }
    bool matched = false;
    bool first = true;
    for (; i < pattern.size(); ++i) {
        if (pattern[i] == ']' && !first) break;
        first = false;
        if (i + 2 < pattern.size() && pattern[i + 1] == '-' && pattern[i + 2] != ']') {
            if (c >= pattern[i] && c <= pattern[i + 2]) matched = true;
            i += 2;
        } else if (pattern[i] == c) {
            matched = true;
        }
    }
    if (i >= pattern.size()) return false; // unterminated class never matches
    cursor = i;                            // now sits on the closing bracket
    return matched != negate;
}

bool matchCore(std::string_view pattern, size_t pi, std::string_view text, size_t ti) {
    while (pi < pattern.size()) {
        const char pc = pattern[pi];

        if (pc == '*') {
            const bool doubleStar = (pi + 1 < pattern.size() && pattern[pi + 1] == '*');
            size_t next = pi + (doubleStar ? 2 : 1);
            if (doubleStar) {
                // A leading "**/" also has to match zero directories, so try
                // skipping the separator as well as consuming it.
                if (next < pattern.size() && pattern[next] == '/') {
                    if (matchCore(pattern, next + 1, text, ti)) return true;
                    ++next;
                }
                for (size_t t = ti; t <= text.size(); ++t) {
                    if (matchCore(pattern, next, text, t)) return true;
                }
                return false;
            }
            for (size_t t = ti; t <= text.size(); ++t) {
                if (matchCore(pattern, next, text, t)) return true;
                if (t < text.size() && text[t] == '/') break; // a single * stops at a separator
            }
            return false;
        }

        if (ti >= text.size()) return false;

        if (pc == '?') {
            if (text[ti] == '/') return false;
            ++pi;
            ++ti;
            continue;
        }
        if (pc == '[') {
            size_t cursor = pi;
            if (!matchClass(pattern, cursor, text[ti])) return false;
            pi = cursor + 1;
            ++ti;
            continue;
        }
        if (pc != text[ti]) return false;
        ++pi;
        ++ti;
    }
    return ti == text.size();
}

void expandBraces(std::string_view pattern, std::vector<std::string>& out, int depth = 0) {
    if (depth > 4) { // guard against pathological nesting
        out.emplace_back(pattern);
        return;
    }
    size_t open = std::string_view::npos;
    int level = 0;
    for (size_t i = 0; i < pattern.size(); ++i) {
        if (pattern[i] == '{') {
            if (level == 0) open = i;
            ++level;
        } else if (pattern[i] == '}') {
            --level;
            if (level == 0 && open != std::string_view::npos) {
                const std::string_view head = pattern.substr(0, open);
                const std::string_view body = pattern.substr(open + 1, i - open - 1);
                const std::string_view tail = pattern.substr(i + 1);
                size_t start = 0;
                int inner = 0;
                for (size_t j = 0; j <= body.size(); ++j) {
                    if (j == body.size() || (body[j] == ',' && inner == 0)) {
                        std::string combined;
                        combined.append(head).append(body.substr(start, j - start)).append(tail);
                        expandBraces(combined, out, depth + 1);
                        start = j + 1;
                    } else if (body[j] == '{') {
                        ++inner;
                    } else if (body[j] == '}') {
                        --inner;
                    }
                }
                return;
            }
        }
    }
    out.emplace_back(pattern);
}

} // namespace

bool globMatch(std::string_view pattern, std::string_view text) {
    std::vector<std::string> alternatives;
    expandBraces(pattern, alternatives);
    for (const auto& alternative : alternatives) {
        if (matchCore(alternative, 0, text, 0)) return true;
    }
    return false;
}

std::string humanBytes(long long bytes) {
    char buffer[64];
    const double value = static_cast<double>(bytes);
    if (bytes < 1024) std::snprintf(buffer, sizeof(buffer), "%lld B", bytes);
    else if (bytes < 1024 * 1024) std::snprintf(buffer, sizeof(buffer), "%.1f KB", value / 1024.0);
    else std::snprintf(buffer, sizeof(buffer), "%.1f MB", value / (1024.0 * 1024.0));
    return buffer;
}

std::string humanCount(long long value) {
    char buffer[64];
    if (value < 1000) std::snprintf(buffer, sizeof(buffer), "%lld", value);
    else if (value < 1000000) std::snprintf(buffer, sizeof(buffer), "%.1fk", static_cast<double>(value) / 1000.0);
    else std::snprintf(buffer, sizeof(buffer), "%.2fM", static_cast<double>(value) / 1000000.0);
    return buffer;
}

std::string localDateIso() {
    SYSTEMTIME st{};
    ::GetLocalTime(&st);
    char buffer[16];
    std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02d", st.wYear, st.wMonth, st.wDay);
    return buffer;
}

std::string timezoneName() {
    DYNAMIC_TIME_ZONE_INFORMATION tz{};
    const DWORD result = ::GetDynamicTimeZoneInformation(&tz);
    if (result == TIME_ZONE_ID_INVALID) return {};
    const wchar_t* name = (result == TIME_ZONE_ID_DAYLIGHT) ? tz.DaylightName : tz.StandardName;
    return toUtf8(name);
}

std::string osVersionString() {
    // GetVersionEx reports a capped version without an explicit manifest, so
    // read the real product/build strings from the registry for display.
    HKEY key{};
    if (::RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", 0,
                        KEY_READ, &key) != ERROR_SUCCESS) {
        return "Windows";
    }
    wchar_t productName[256]{};
    wchar_t build[64]{};
    DWORD size = sizeof(productName);
    std::string out = "Windows";
    if (::RegQueryValueExW(key, L"ProductName", nullptr, nullptr, reinterpret_cast<LPBYTE>(productName), &size) == ERROR_SUCCESS) {
        out = toUtf8(productName);
    }
    size = sizeof(build);
    if (::RegQueryValueExW(key, L"CurrentBuild", nullptr, nullptr, reinterpret_cast<LPBYTE>(build), &size) == ERROR_SUCCESS) {
        out += " (build " + toUtf8(build) + ")";
    }
    ::RegCloseKey(key);
    return out;
}

long long nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

void Dispatcher::post(std::function<void()> fn) {
    std::lock_guard<std::mutex> lock(mutex_);
    queue_.push_back(std::move(fn));
}

void Dispatcher::drain() {
    std::deque<std::function<void()>> pending;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        pending.swap(queue_);
    }
    for (auto& fn : pending) fn();
}

} // namespace dc
