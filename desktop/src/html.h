// HTML entity decoding and HTML-to-Markdown conversion for `webFetch`.
//
// Mirrors packages/cli/src/lib/web/{entities,html-to-markdown}.ts. The CLI
// builds on Bun's streaming HTMLRewriter; there is no equivalent here, so this
// carries its own tag scanner. The semantics it reproduces are the ones that
// matter to a reader: dropped chrome, block structure, code fences, resolved
// link targets, and collapsed whitespace.
//
// The aim is legibility and token economy, not fidelity.
#pragma once

#include <string>
#include <string_view>

namespace dc {

/// Decodes numeric references plus the named entities that appear in prose.
/// Anything unrecognised is left exactly as written — a stray `&mdash;` is
/// cosmetic, whereas mangling text that merely looks like an entity is data
/// loss. Undecoded hrefs matter more than prose: `?a=1&amp;b=2` fetched
/// verbatim asks the server for a parameter named "amp;b".
std::string decodeHtmlEntities(std::string_view value);

struct MarkdownResult {
    std::string markdown;
    std::string title; // contents of <title>, empty when absent
    bool truncated = false;
};

/// `baseUrl` resolves relative hrefs, so links stay followable — a relative
/// link is useless to a model that has no idea what it was relative to.
/// `maxChars` caps the output.
MarkdownResult htmlToMarkdown(std::string_view html, const std::string& baseUrl, size_t maxChars);

/// Resolves `reference` against `base` (RFC 3986, the subset real pages use).
/// Returns an empty string when the result would not be a usable absolute URL.
std::string resolveUrl(const std::string& base, const std::string& reference);

} // namespace dc
