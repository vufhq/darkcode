#include "html.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdlib>
#include <map>
#include <set>
#include <vector>

#include "util.h"

namespace dc {
namespace {

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const std::map<std::string, std::string>& namedEntities() {
    // Same table as the CLI. `nbsp` deliberately maps to a plain space rather
    // than U+00A0: invisible characters are copyable into code, where they are
    // a genuinely nasty class of bug.
    static const std::map<std::string, std::string> table = {
        {"amp", "&"},      {"lt", "<"},        {"gt", ">"},       {"quot", "\""},
        {"apos", "'"},     {"nbsp", " "},      {"copy", "©"},{"reg", "®"},
        {"trade", "™"},{"hellip", "…"},{"mdash", "—"},{"ndash", "–"},
        {"lsquo", "‘"},{"rsquo", "’"},{"ldquo", "“"},{"rdquo", "”"},
        {"laquo", "«"},{"raquo", "»"},{"bull", "•"},{"middot", "·"},
        {"dagger", "†"},{"deg", "°"},{"plusmn", "±"},{"times", "×"},
        {"divide", "÷"},{"minus", "−"},{"ne", "≠"}, {"le", "≤"},
        {"ge", "≥"},  {"larr", "←"}, {"rarr", "→"},{"harr", "↔"},
        {"darr", "↓"},{"uarr", "↑"}, {"euro", "€"},{"pound", "£"},
        {"yen", "¥"}, {"cent", "¢"}, {"sect", "§"},{"para", "¶"},
        {"frac12", "½"},{"frac14", "¼"},{"frac34", "¾"},
        {"ensp", " "},     {"emsp", " "},      {"thinsp", " "},
        {"shy", ""},       {"zwj", ""},        {"zwnj", ""},
    };
    return table;
}

/// Surrogates are not scalar values, and NUL terminates strings in enough
/// downstream contexts to refuse outright. Both are left as literal source.
bool isForbiddenCodePoint(long long code) {
    return code <= 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF);
}

void appendUtf8(std::string& out, long long code) {
    const auto value = static_cast<unsigned long>(code);
    if (value < 0x80) {
        out.push_back(static_cast<char>(value));
    } else if (value < 0x800) {
        out.push_back(static_cast<char>(0xC0 | (value >> 6)));
        out.push_back(static_cast<char>(0x80 | (value & 0x3F)));
    } else if (value < 0x10000) {
        out.push_back(static_cast<char>(0xE0 | (value >> 12)));
        out.push_back(static_cast<char>(0x80 | ((value >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (value & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (value >> 18)));
        out.push_back(static_cast<char>(0x80 | ((value >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((value >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (value & 0x3F)));
    }
}

// ---------------------------------------------------------------------------
// Tag sets
// ---------------------------------------------------------------------------

/// Subtrees dropped entirely. `header` is deliberately absent — it frequently
/// holds the <h1>. `head` is dropped, but <title> is pulled out of it first.
const std::set<std::string>& droppedTags() {
    static const std::set<std::string> tags = {"head",     "script", "style", "noscript",
                                               "svg",      "iframe", "template", "nav",
                                               "footer",   "form"};
    return tags;
}

/// Tags whose content is raw text: scanning for the close tag is the only
/// correct way to skip them, since `a < b` inside a script is not a tag.
const std::set<std::string>& rawTextTags() {
    static const std::set<std::string> tags = {"script", "style", "textarea", "title"};
    return tags;
}

const std::map<std::string, std::string>& blockPrefixes() {
    static const std::map<std::string, std::string> prefixes = {
        {"h1", "# "},   {"h2", "## "},  {"h3", "### "},
        {"h4", "#### "},{"h5", "##### "},{"h6", "###### "},
        {"li", "- "},   {"blockquote", "> "},
    };
    return prefixes;
}

const std::set<std::string>& blockTags() {
    static const std::set<std::string> tags = {
        "p",  "div", "section", "article", "main", "aside", "li", "ul", "ol",
        "tr", "table", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
        "pre", "hr", "br", "dt", "dd",
    };
    return tags;
}

const std::set<std::string>& voidTags() {
    static const std::set<std::string> tags = {"br",  "hr",   "img",  "input", "meta",
                                               "link","area", "base", "col",   "embed",
                                               "source", "track", "wbr"};
    return tags;
}

// ---------------------------------------------------------------------------
// Tag scanning
// ---------------------------------------------------------------------------

struct Tag {
    std::string name;
    bool closing = false;
    bool selfClosing = false;
    std::map<std::string, std::string> attributes;
};

bool isNameChar(char c) {
    return std::isalnum(static_cast<unsigned char>(c)) != 0 || c == '-' || c == '_' || c == ':';
}

/// Parses the tag starting at `html[start]` (which must be '<'). Returns the
/// index just past '>', or npos when the tag never closes.
size_t parseTag(std::string_view html, size_t start, Tag& out) {
    size_t i = start + 1;
    if (i < html.size() && html[i] == '/') {
        out.closing = true;
        ++i;
    }
    const size_t nameStart = i;
    while (i < html.size() && isNameChar(html[i])) ++i;
    out.name = toLower(html.substr(nameStart, i - nameStart));
    if (out.name.empty()) return std::string_view::npos;

    while (i < html.size() && html[i] != '>') {
        while (i < html.size() && std::isspace(static_cast<unsigned char>(html[i]))) ++i;
        if (i >= html.size() || html[i] == '>') break;
        if (html[i] == '/') {
            out.selfClosing = true;
            ++i;
            continue;
        }

        const size_t attrStart = i;
        while (i < html.size() && html[i] != '=' && html[i] != '>' &&
               !std::isspace(static_cast<unsigned char>(html[i]))) {
            ++i;
        }
        const std::string attribute = toLower(html.substr(attrStart, i - attrStart));

        while (i < html.size() && std::isspace(static_cast<unsigned char>(html[i]))) ++i;
        std::string value;
        if (i < html.size() && html[i] == '=') {
            ++i;
            while (i < html.size() && std::isspace(static_cast<unsigned char>(html[i]))) ++i;
            if (i < html.size() && (html[i] == '"' || html[i] == '\'')) {
                const char quote = html[i++];
                const size_t valueStart = i;
                while (i < html.size() && html[i] != quote) ++i;
                value = std::string(html.substr(valueStart, i - valueStart));
                if (i < html.size()) ++i; // closing quote
            } else {
                const size_t valueStart = i;
                while (i < html.size() && html[i] != '>' &&
                       !std::isspace(static_cast<unsigned char>(html[i]))) {
                    ++i;
                }
                value = std::string(html.substr(valueStart, i - valueStart));
            }
        }
        if (!attribute.empty()) out.attributes.emplace(attribute, std::move(value));
    }

    if (i >= html.size()) return std::string_view::npos;
    return i + 1; // past '>'
}

/// Finds `</name` from `from`, case-insensitively.
size_t findCloseTag(std::string_view html, const std::string& name, size_t from) {
    const std::string needle = "</" + name;
    for (size_t i = from; i + needle.size() <= html.size(); ++i) {
        if (toLower(html.substr(i, needle.size())) == needle) return i;
    }
    return std::string_view::npos;
}

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

struct SplitUrl {
    std::string scheme;
    std::string authority;
    std::string path;
    std::string query;
    bool valid = false;
};

SplitUrl splitUrl(const std::string& url) {
    SplitUrl out;
    const size_t schemeEnd = url.find("://");
    if (schemeEnd == std::string::npos) return out;

    out.scheme = toLower(url.substr(0, schemeEnd));
    size_t cursor = schemeEnd + 3;
    const size_t authorityEnd = url.find_first_of("/?#", cursor);
    out.authority = url.substr(cursor, authorityEnd == std::string::npos ? std::string::npos
                                                                        : authorityEnd - cursor);
    if (authorityEnd == std::string::npos) {
        out.path = "/";
    } else {
        const size_t queryStart = url.find('?', authorityEnd);
        const size_t fragmentStart = url.find('#', authorityEnd);
        const size_t pathEnd = std::min(queryStart, fragmentStart);
        out.path = url.substr(authorityEnd, pathEnd == std::string::npos ? std::string::npos
                                                                        : pathEnd - authorityEnd);
        if (queryStart != std::string::npos && (fragmentStart == std::string::npos || queryStart < fragmentStart)) {
            const size_t queryEnd = fragmentStart == std::string::npos ? std::string::npos
                                                                      : fragmentStart - queryStart;
            out.query = url.substr(queryStart, queryEnd);
        }
        if (out.path.empty()) out.path = "/";
    }
    out.valid = !out.authority.empty();
    return out;
}

/// Removes "." and ".." segments, per RFC 3986 section 5.2.4.
std::string normalizePath(const std::string& path) {
    std::vector<std::string> segments;
    size_t i = 0;
    while (i < path.size()) {
        size_t slash = path.find('/', i);
        if (slash == std::string::npos) slash = path.size();
        const std::string segment = path.substr(i, slash - i);
        if (segment == "..") {
            if (!segments.empty()) segments.pop_back();
        } else if (segment != "." && !segment.empty()) {
            segments.push_back(segment);
        }
        i = slash + 1;
    }
    std::string out;
    for (const std::string& segment : segments) out += "/" + segment;
    if (out.empty()) out = "/";
    if (!path.empty() && path.back() == '/' && out.back() != '/') out += "/";
    return out;
}

} // namespace

std::string decodeHtmlEntities(std::string_view value) {
    // Cheap bail-out: most text chunks contain no '&' at all, and this runs
    // once per chunk on every page fetched.
    if (value.find('&') == std::string_view::npos) return std::string(value);

    std::string out;
    out.reserve(value.size());

    for (size_t i = 0; i < value.size(); ++i) {
        if (value[i] != '&') {
            out.push_back(value[i]);
            continue;
        }

        const size_t semicolon = value.find(';', i + 1);
        // 33 = '#' + up to 32 body characters, matching the CLI's bound.
        if (semicolon == std::string_view::npos || semicolon - i > 33 || semicolon == i + 1) {
            out.push_back('&');
            continue;
        }

        const std::string_view body = value.substr(i + 1, semicolon - i - 1);
        if (body[0] == '#') {
            const bool hex = body.size() > 1 && (body[1] == 'x' || body[1] == 'X');
            const std::string digits(body.substr(hex ? 2 : 1));
            if (digits.empty()) {
                out.push_back('&');
                continue;
            }
            const bool allValid = std::all_of(digits.begin(), digits.end(), [hex](char c) {
                return hex ? std::isxdigit(static_cast<unsigned char>(c)) != 0
                           : std::isdigit(static_cast<unsigned char>(c)) != 0;
            });
            if (!allValid) {
                out.push_back('&');
                continue;
            }
            const long long code = std::strtoll(digits.c_str(), nullptr, hex ? 16 : 10);
            if (isForbiddenCodePoint(code)) {
                out.push_back('&');
                continue;
            }
            appendUtf8(out, code);
            i = semicolon;
            continue;
        }

        const bool alphanumeric =
            std::isalpha(static_cast<unsigned char>(body[0])) != 0 &&
            std::all_of(body.begin(), body.end(),
                        [](char c) { return std::isalnum(static_cast<unsigned char>(c)) != 0; });
        const auto& table = namedEntities();
        const auto found = alphanumeric ? table.find(std::string(body)) : table.end();
        if (found == table.end()) {
            out.push_back('&');
            continue;
        }
        out += found->second;
        i = semicolon;
    }
    return out;
}

std::string resolveUrl(const std::string& base, const std::string& reference) {
    const std::string trimmed = trim(reference);
    if (trimmed.empty()) return {};

    // Already absolute.
    if (trimmed.find("://") != std::string::npos) {
        const std::string scheme = toLower(trimmed.substr(0, trimmed.find("://")));
        if (scheme != "http" && scheme != "https") return {};
        return trimmed;
    }
    // Schemes with no authority are never fetchable content.
    const size_t colon = trimmed.find(':');
    if (colon != std::string::npos && colon < trimmed.find('/')) {
        const std::string scheme = toLower(trimmed.substr(0, colon));
        if (scheme == "javascript" || scheme == "mailto" || scheme == "data" || scheme == "tel" ||
            scheme == "file" || scheme == "blob") {
            return {};
        }
    }

    const SplitUrl split = splitUrl(base);
    if (!split.valid) return {};
    const std::string origin = split.scheme + "://" + split.authority;

    if (startsWith(trimmed, "//")) return split.scheme + ":" + trimmed;
    if (startsWith(trimmed, "/")) {
        const size_t cut = trimmed.find_first_of("#");
        return origin + (cut == std::string::npos ? trimmed : trimmed.substr(0, cut));
    }

    // Relative to the base's directory.
    std::string directory = split.path;
    const size_t lastSlash = directory.find_last_of('/');
    directory = lastSlash == std::string::npos ? "/" : directory.substr(0, lastSlash + 1);

    std::string combined = directory + trimmed;
    const size_t fragment = combined.find('#');
    if (fragment != std::string::npos) combined = combined.substr(0, fragment);

    std::string query;
    const size_t queryStart = combined.find('?');
    if (queryStart != std::string::npos) {
        query = combined.substr(queryStart);
        combined = combined.substr(0, queryStart);
    }
    return origin + normalizePath(combined) + query;
}

MarkdownResult htmlToMarkdown(std::string_view html, const std::string& baseUrl, size_t maxChars) {
    MarkdownResult result;
    std::string out;
    out.reserve(std::min<size_t>(html.size(), maxChars) + 1024);

    int dropDepth = 0; // >0 inside a dropped subtree; nested drops are why it counts
    int preDepth = 0;  // >0 inside <pre>, where whitespace is significant
    std::vector<std::string> pendingLinks;

    const auto emit = [&out](std::string_view text) { out.append(text); };

    // Starts a new block without stacking blank lines. Real HTML nests div in
    // div in section, so "newline per block tag" yields pages of whitespace.
    const auto startBlock = [&](const std::string& prefix, bool tight) {
        if (!out.empty()) {
            if (tight) {
                if (out.back() != '\n') emit("\n");
            } else if (!endsWith(out, "\n\n")) {
                emit(endsWith(out, "\n") ? "\n" : "\n\n");
            }
        }
        emit(prefix);
    };

    size_t i = 0;
    while (i < html.size()) {
        if (html[i] != '<') {
            const size_t next = html.find('<', i);
            const std::string_view raw = html.substr(i, (next == std::string_view::npos ? html.size() : next) - i);
            i = (next == std::string_view::npos) ? html.size() : next;

            if (dropDepth > 0) continue;
            if (out.size() >= maxChars) continue;

            if (preDepth > 0) {
                emit(decodeHtmlEntities(raw));
                continue;
            }

            // Collapse runs of whitespace, including the newlines HTML authors
            // use purely for source formatting.
            const std::string decoded = decodeHtmlEntities(raw);
            std::string collapsed;
            collapsed.reserve(decoded.size());
            bool inSpace = false;
            for (const char c : decoded) {
                if (std::isspace(static_cast<unsigned char>(c))) {
                    if (!inSpace) {
                        collapsed.push_back(' ');
                        inSpace = true;
                    }
                } else {
                    collapsed.push_back(c);
                    inSpace = false;
                }
            }
            if (trim(collapsed).empty()) {
                // Preserve a single separating space, but never start a line or
                // a link label with one.
                if (collapsed == " " && !out.empty() &&
                    !std::isspace(static_cast<unsigned char>(out.back())) && out.back() != '[') {
                    emit(" ");
                }
                continue;
            }
            emit(collapsed);
            continue;
        }

        // Comments and doctypes carry nothing.
        if (html.compare(i, 4, "<!--") == 0) {
            const size_t end = html.find("-->", i + 4);
            i = (end == std::string_view::npos) ? html.size() : end + 3;
            continue;
        }
        if (i + 1 < html.size() && html[i + 1] == '!') {
            const size_t end = html.find('>', i);
            i = (end == std::string_view::npos) ? html.size() : end + 1;
            continue;
        }

        Tag tag;
        const size_t after = parseTag(html, i, tag);
        if (after == std::string_view::npos) {
            // A stray '<' that never closes is text, not markup.
            if (dropDepth == 0 && out.size() < maxChars) emit("<");
            ++i;
            continue;
        }
        i = after;

        // <title> is read even inside <head>, which is otherwise dropped: it is
        // the page's own name for itself and is worth more as a labelled field.
        if (!tag.closing && tag.name == "title") {
            const size_t close = findCloseTag(html, "title", i);
            const size_t end = (close == std::string_view::npos) ? html.size() : close;
            result.title = trim(decodeHtmlEntities(html.substr(i, end - i)));
            i = end;
            continue;
        }

        // Raw-text elements: skip to the close tag rather than tokenising, or
        // `a < b` inside a script becomes a tag.
        if (!tag.closing && !tag.selfClosing && rawTextTags().count(tag.name) > 0) {
            const size_t close = findCloseTag(html, tag.name, i);
            i = (close == std::string_view::npos) ? html.size() : close;
            continue;
        }

        if (droppedTags().count(tag.name) > 0) {
            if (tag.closing) {
                if (dropDepth > 0) --dropDepth;
            } else if (!tag.selfClosing) {
                ++dropDepth;
            }
            continue;
        }
        if (dropDepth > 0) continue;

        if (tag.name == "a") {
            if (preDepth > 0) continue;
            if (tag.closing) {
                if (!pendingLinks.empty()) {
                    emit("](" + pendingLinks.back() + ")");
                    pendingLinks.pop_back();
                }
                continue;
            }
            const auto href = tag.attributes.find("href");
            if (href == tag.attributes.end()) continue;
            const std::string resolved = resolveUrl(baseUrl, decodeHtmlEntities(href->second));
            if (resolved.empty()) continue;
            pendingLinks.push_back(resolved);
            emit("[");
            continue;
        }

        if (tag.name == "code") {
            // Inside <pre> the fence already marks it as code; backticks there
            // would nest a code span inside a code block.
            if (preDepth == 0) emit("`");
            continue;
        }

        if (tag.name == "img" && !tag.closing) {
            // Alt text is the only part of an image a text model can use, and
            // on diagrams it is often the only description present.
            const auto alt = tag.attributes.find("alt");
            if (alt != tag.attributes.end()) {
                const std::string text = trim(decodeHtmlEntities(alt->second));
                if (!text.empty()) emit("![" + text + "]");
            }
            continue;
        }

        if (tag.name == "pre") {
            if (tag.closing) {
                if (preDepth > 0) {
                    --preDepth;
                    emit("\n```");
                }
            } else if (!tag.selfClosing) {
                ++preDepth;
                startBlock("```\n", false);
            }
            continue;
        }

        if (blockTags().count(tag.name) == 0) continue;
        if (tag.closing) {
            // Closing a block tag also ends the line, so the next block does not
            // run into it.
            if (!out.empty() && out.back() != '\n' && voidTags().count(tag.name) == 0) emit("\n");
            continue;
        }

        if (tag.name == "br") {
            emit("\n");
            continue;
        }
        if (tag.name == "hr") {
            startBlock("---", false);
            continue;
        }

        const auto prefix = blockPrefixes().find(tag.name);
        // List items are tight — one newline, not a blank line each. A 40-item
        // list double-spaced is 40 wasted lines of context.
        const bool tight = tag.name == "li" || tag.name == "dt" || tag.name == "dd";
        startBlock(prefix == blockPrefixes().end() ? "" : prefix->second, tight);
    }

    // An unterminated <a> (truncated or malformed page) would otherwise leave a
    // dangling "[" that reads as broken Markdown.
    while (!pendingLinks.empty()) {
        emit("](" + pendingLinks.back() + ")");
        pendingLinks.pop_back();
    }

    // Three or more newlines is always an artifact of nested block tags, and
    // trailing spaces are invisible noise that still costs tokens.
    std::string cleaned;
    cleaned.reserve(out.size());
    size_t newlineRun = 0;
    for (const char c : out) {
        if (c == '\n') {
            ++newlineRun;
            if (newlineRun > 2) continue;
            while (!cleaned.empty() && (cleaned.back() == ' ' || cleaned.back() == '\t')) {
                cleaned.pop_back();
            }
            cleaned.push_back(c);
            continue;
        }
        newlineRun = 0;
        cleaned.push_back(c);
    }

    std::string trimmed = trim(cleaned);
    result.truncated = trimmed.size() > maxChars;
    result.markdown = result.truncated ? trimmed.substr(0, maxChars) : trimmed;
    return result;
}

} // namespace dc
