#include "permissions.h"

#include <algorithm>
#include <array>
#include <string_view>
#include <vector>

#include "util.h"

namespace dc {
namespace {

// Mirrors DEFAULT_POLICY.fs.denyRead in the CLI: files whose contents must
// never reach the model, whatever the user clicks.
constexpr std::array<std::string_view, 20> kDenyRead{{
    ".env", ".env.*", "**/.env", "**/.env.*",
    "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx",
    "**/id_rsa", "**/id_ed25519", "**/id_ecdsa",
    "**/.ssh/**", "**/.aws/**", "**/.gnupg/**",
    "**/.npmrc", "**/.pypirc", "**/.netrc", "**/.git-credentials",
    "**/.darkcode/auth.json", "**/.darkcode/api-keys.json",
}};

// Mirrors DEFAULT_POLICY.fs.denyWrite.
constexpr std::array<std::string_view, 11> kDenyWrite{{
    ".env", ".env.*", "**/.env", "**/.env.*",
    "**/*.pem", "**/*.key",
    "**/id_rsa", "**/id_ed25519",
    "**/.ssh/**", "**/.aws/**", "**/.gnupg/**",
}};

// Catastrophic or privilege-escalating commands. Never promptable.
constexpr std::array<std::string_view, 14> kDenyBash{{
    "rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf ~/**",
    "rm -rf $HOME", "rm -rf $HOME/**",
    "sudo **", "su **", "doas **",
    "curl ** | sh", "curl ** | bash",
    "wget ** | sh", "wget ** | bash",
    ":(){ :|:& };:",
}};

// Read-only inspection commands that never need a prompt.
constexpr std::array<std::string_view, 22> kAllowBash{{
    "git status", "git status **", "git diff", "git diff **",
    "git log", "git log **", "git show **",
    "git branch", "git branch **", "git remote", "git remote -v",
    "ls", "ls **", "pwd", "wc **", "echo **", "which **",
    "node --version", "bun --version", "npm --version",
    "bun test", "bun test **",
}};

// Cloud instance-metadata endpoints. Link-local addresses that hand out
// short-lived cloud credentials to anything on the box that asks, with no
// authentication — the single most valuable target reachable from a machine
// running an agent, and nothing a coding assistant legitimately needs.
//
// This list is why redirects are re-checked hop by hop: an allowed host that
// 302s to 169.254.169.254 would otherwise walk straight past it.
constexpr std::array<std::string_view, 6> kDenyWebHosts{{
    "169.254.169.254",
    "[fd00:ec2::254]",
    "metadata.google.internal",
    "metadata.goog",
    "100.100.100.200",
    "metadata.azure.com",
}};

/// Splits `host[:port]`, leaving bracketed IPv6 literals intact. A naive
/// split on ':' would read `::1` as a port and silently match no rule — which
/// in a security check means falling through to a decision nobody intended.
std::pair<std::string, std::string> splitHostPort(const std::string& value) {
    if (!value.empty() && value.front() == '[') {
        const size_t close = value.find(']');
        if (close == std::string::npos) return {value, ""};
        const std::string rest = value.substr(close + 1);
        return {value.substr(0, close + 1), startsWith(rest, ":") ? rest.substr(1) : ""};
    }
    const size_t colon = value.find_last_of(':');
    if (colon == std::string::npos) return {value, ""};
    return {value.substr(0, colon), value.substr(colon + 1)};
}

std::string normalizePath(std::string path) {
    std::replace(path.begin(), path.end(), '\\', '/');
    if (startsWith(path, "./")) path.erase(0, 2);
    return path;
}

bool matchesAny(const std::string& value, const std::string_view* patterns, size_t count) {
    for (size_t i = 0; i < count; ++i) {
        if (globMatch(patterns[i], value)) return true;
    }
    return false;
}

/// Splits a command line on the operators that chain simple commands, so each
/// segment can be classified on its own.
std::vector<std::string> splitCommandSegments(const std::string& command) {
    std::vector<std::string> segments;
    std::string current;
    for (size_t i = 0; i < command.size(); ++i) {
        const char c = command[i];
        const bool twoChar = (i + 1 < command.size()) && (command[i + 1] == c);
        if (c == '|' || c == ';' || (c == '&' && twoChar)) {
            segments.push_back(trim(current));
            current.clear();
            if (twoChar && (c == '|' || c == '&')) ++i;
            continue;
        }
        current.push_back(c);
    }
    segments.push_back(trim(current));
    segments.erase(std::remove_if(segments.begin(), segments.end(),
                                  [](const std::string& s) { return s.empty(); }),
                   segments.end());
    return segments;
}

std::string firstWord(const std::string& command) {
    const size_t space = command.find(' ');
    return space == std::string::npos ? command : command.substr(0, space);
}

} // namespace

bool PermissionBroker::isReadProtected(const std::string& projectRelativePath) {
    return matchesAny(normalizePath(projectRelativePath), kDenyRead.data(), kDenyRead.size());
}

bool PermissionBroker::isWriteProtected(const std::string& projectRelativePath) {
    return matchesAny(normalizePath(projectRelativePath), kDenyWrite.data(), kDenyWrite.size());
}

bool PermissionBroker::matchesHostPattern(const std::string& host, const std::string& pattern) {
    const std::string value = toLower(host);
    const std::string rule = toLower(trim(pattern));
    if (rule == "**" || rule == "*") return true;

    const auto [valueHost, valuePort] = splitHostPort(value);
    const auto [ruleHost, rulePort] = splitHostPort(rule);

    if (!rulePort.empty() && rulePort != valuePort) return false;

    if (startsWith(ruleHost, "*.")) {
        // ".example.com" — any subdomain, but not the apex, matching how
        // certificates and cookie domains are normally read.
        const std::string suffix = ruleHost.substr(1);
        return endsWith(valueHost, suffix) && valueHost.size() > suffix.size();
    }
    return ruleHost == valueHost;
}

const char* PermissionBroker::classifyWeb(const std::string& host) {
    if (trim(host).empty()) return "deny";
    for (const auto& pattern : kDenyWebHosts) {
        if (matchesHostPattern(host, std::string(pattern))) return "deny";
    }
    // Nothing is pre-approved: the first fetch of any host prompts.
    return "ask";
}

const char* PermissionBroker::classifyBash(const std::string& command) {
    const std::string normalized = trim(command);
    if (normalized.empty()) return "deny";

    // Deny patterns are tested against the whole line so pipe-to-shell rules
    // like "curl ** | sh" still match.
    if (matchesAny(normalized, kDenyBash.data(), kDenyBash.size())) return "deny";

    const auto segments = splitCommandSegments(normalized);
    if (segments.empty()) return "deny";
    for (const auto& segment : segments) {
        if (matchesAny(segment, kDenyBash.data(), kDenyBash.size())) return "deny";
    }
    for (const auto& segment : segments) {
        if (!matchesAny(segment, kAllowBash.data(), kAllowBash.size())) return "ask";
    }
    return "allow";
}

PermissionOutcome PermissionBroker::ask(const PermissionRequest& request) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (cancelled_) return {false, "Turn stopped before the request was answered"};

    // One prompt at a time; tools run sequentially, so this only guards against
    // a late arrival racing an open dialog.
    cv_.wait(lock, [this] { return !hasPending_ || cancelled_; });
    if (cancelled_) return {false, "Turn stopped before the request was answered"};

    request_ = request;
    decision_ = PermissionDecision::Pending;
    hasPending_ = true;
    cv_.notify_all();

    cv_.wait(lock, [this] { return decision_ != PermissionDecision::Pending || cancelled_; });

    const PermissionDecision decision = cancelled_ ? PermissionDecision::Deny : decision_;
    hasPending_ = false;
    decision_ = PermissionDecision::Pending;
    cv_.notify_all();

    if (decision == PermissionDecision::Deny) {
        return {false, "The user denied this request"};
    }

    if (decision == PermissionDecision::AllowSession) {
        switch (request.kind) {
            case PermissionKind::FsRead: allowAllReads_ = true; break;
            case PermissionKind::FsWrite: allowAllWrites_ = true; break;
            case PermissionKind::Bash: allowedCommands_.insert(request.grantKey); break;
            case PermissionKind::Web: allowedHosts_.insert(request.grantKey); break;
        }
    }
    return {true, {}};
}

PermissionOutcome PermissionBroker::checkRead(const std::string& projectRelativePath, bool autoApprove) {
    if (isReadProtected(projectRelativePath)) {
        return {false,
                "Reading " + projectRelativePath +
                    " is blocked: it matches a protected-secret pattern, so its contents are never sent to the model."};
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (cancelled_) return {false, "Turn stopped"};
        if (autoApprove || allowAllReads_) return {true, {}};
    }

    PermissionRequest request;
    request.kind = PermissionKind::FsRead;
    request.title = "Read a file";
    request.subject = projectRelativePath;
    request.sessionLabel = "Allow all reads this session";
    return ask(request);
}

PermissionOutcome PermissionBroker::checkWrite(const std::string& projectRelativePath,
                                               const std::string& preview,
                                               bool autoApprove) {
    if (isWriteProtected(projectRelativePath)) {
        return {false,
                "Writing " + projectRelativePath +
                    " is blocked: it matches a protected-secret pattern."};
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (cancelled_) return {false, "Turn stopped"};
        if (autoApprove || allowAllWrites_) return {true, {}};
    }

    PermissionRequest request;
    request.kind = PermissionKind::FsWrite;
    request.title = "Write to a file";
    request.subject = projectRelativePath;
    request.detail = preview;
    request.sessionLabel = "Allow all writes this session";
    return ask(request);
}

PermissionOutcome PermissionBroker::checkBash(const std::string& command, bool autoApprove) {
    const std::string classification = classifyBash(command);
    if (classification == "deny") {
        return {false, "This command is blocked by the default DarkCode policy."};
    }
    if (classification == "allow") return {true, {}};

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (cancelled_) return {false, "Turn stopped"};
        if (autoApprove) return {true, {}};
        if (allowedCommands_.count(command) > 0) return {true, {}};
    }

    PermissionRequest request;
    request.kind = PermissionKind::Bash;
    request.title = "Run a shell command";
    request.subject = command;
    request.detail = "Runs through bash in the project directory.";
    request.grantKey = command;
    request.sessionLabel = "Always allow \"" + firstWord(command) + " ...\" this session";
    // Note: the session grant is keyed on the exact command, not the program,
    // so approving `git push origin main` never blanket-approves `git push`.
    return ask(request);
}

PermissionOutcome PermissionBroker::checkWeb(const std::string& url,
                                             const std::string& host,
                                             bool autoApprove) {
    if (std::string(classifyWeb(host)) == "deny") {
        return {false,
                "Fetching " + host +
                    " is blocked: it is a cloud instance-metadata endpoint, which hands out "
                    "credentials to anything that asks."};
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (cancelled_) return {false, "Turn stopped"};
        if (autoApprove) return {true, {}};
        if (allowedHosts_.count(toLower(host)) > 0) return {true, {}};
    }

    PermissionRequest request;
    request.kind = PermissionKind::Web;
    request.title = "Fetch a URL";
    request.subject = url;
    request.detail =
        "Fetched from this machine, so it can reach your local network and dev servers. "
        "The response is treated as untrusted data, never as instructions.";
    request.grantKey = toLower(host);
    request.sessionLabel = "Always allow " + host + " this session";
    return ask(request);
}

bool PermissionBroker::hasPending() {
    std::lock_guard<std::mutex> lock(mutex_);
    return hasPending_ && decision_ == PermissionDecision::Pending && !cancelled_;
}

PermissionRequest PermissionBroker::pending() {
    std::lock_guard<std::mutex> lock(mutex_);
    return request_;
}

void PermissionBroker::resolve(PermissionDecision decision) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!hasPending_) return;
        decision_ = decision;
    }
    cv_.notify_all();
}

void PermissionBroker::cancelAll() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        cancelled_ = true;
    }
    cv_.notify_all();
}

void PermissionBroker::clearCancel() {
    std::lock_guard<std::mutex> lock(mutex_);
    cancelled_ = false;
}

void PermissionBroker::resetSessionGrants() {
    std::lock_guard<std::mutex> lock(mutex_);
    allowAllReads_ = false;
    allowAllWrites_ = false;
    allowedCommands_.clear();
    allowedHosts_.clear();
}

} // namespace dc
