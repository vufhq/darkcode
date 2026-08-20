#include "tools.h"

#include <windows.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <regex>
#include <set>
#include <sstream>
#include <thread>

#include "config.h"
#include "util.h"

namespace fs = std::filesystem;

namespace dc {
namespace {

// Same ceilings as the CLI, so a turn costs the same whichever client runs it.
constexpr size_t kMaxReadLines = 2000;
constexpr size_t kMaxReadChars = 400000;
constexpr size_t kMaxLineChars = 2000;
constexpr size_t kMaxResults = 200;
constexpr size_t kMaxMatches = 50;
constexpr size_t kMaxOutput = 20000;
constexpr size_t kMaxGrepFiles = 2000;
constexpr size_t kMaxGrepFileBytes = 2000000;
constexpr int kDefaultBashTimeoutMs = 30000;

constexpr size_t kMaxTodos = 50;
constexpr size_t kMaxTodoContentChars = 200;

const std::set<std::string> kPlanModeTools = {
    "readFile", "listDirectory", "glob", "grep", "todoWrite",
    "lspDefinition", "lspReferences", "lspHover", "lspDiagnostics", "lspSymbols",
};

struct ResolvedPath {
    fs::path absolute;
    std::string projectRelative;
    bool ok = false;
    std::string error;
};

std::string toForwardSlashes(std::string value) {
    std::replace(value.begin(), value.end(), '\\', '/');
    return value;
}

std::string relativeToRoot(const fs::path& root, const fs::path& target) {
    std::error_code ec;
    const fs::path rel = fs::relative(target, root, ec);
    if (ec || rel.empty()) return ".";
    return toForwardSlashes(toUtf8(rel.wstring()));
}

bool isInside(const fs::path& root, const fs::path& candidate) {
    auto rootIt = root.begin();
    auto candidateIt = candidate.begin();
    for (; rootIt != root.end(); ++rootIt, ++candidateIt) {
        if (candidateIt == candidate.end()) return false;
        if (*rootIt != *candidateIt) return false;
    }
    return true;
}

/// Containment check that survives symlinks: a cloned repo can ship a symlink
/// pointing at ~/.ssh, and a purely lexical check would happily follow it.
ResolvedPath resolveInsideProject(const std::string& projectDir, const std::string& path) {
    ResolvedPath result;
    std::error_code ec;

    const fs::path root = fs::weakly_canonical(fs::path(toWide(projectDir)), ec);
    if (ec) {
        result.error = "Project directory does not exist: " + projectDir;
        return result;
    }

    fs::path candidate(toWide(path));
    if (candidate.is_relative()) candidate = root / candidate;

    const fs::path resolved = fs::weakly_canonical(candidate, ec);
    const fs::path finalPath = ec ? candidate.lexically_normal() : resolved;

    if (!isInside(root, finalPath)) {
        result.error = "Path is outside the project directory";
        return result;
    }

    result.absolute = finalPath;
    result.projectRelative = relativeToRoot(root, finalPath);
    result.ok = true;
    return result;
}

std::string readFileText(const fs::path& path, bool* ok = nullptr) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        if (ok) *ok = false;
        return {};
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    if (ok) *ok = true;
    return buffer.str();
}

bool writeFileText(const fs::path& path, const std::string& contents, std::string& error) {
    std::error_code ec;
    fs::create_directories(path.parent_path(), ec);
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) {
        error = "Could not open the file for writing";
        return false;
    }
    out.write(contents.data(), static_cast<std::streamsize>(contents.size()));
    if (!out.good()) {
        error = "Write failed";
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

/// Approximation of git's ignore rules: comments, negation, leading-slash
/// anchoring, trailing-slash directory-only, and `*`/`?`/`**` wildcards. Rules
/// are scoped to the directory whose .gitignore declared them, and the last
/// matching rule wins.
class GitignoreMatcher {
public:
    void add(const std::string& dirRelative, const std::string& contents) {
        for (const std::string& rawLine : splitLines(contents)) {
            std::string line = trim(rawLine);
            if (line.empty() || line[0] == '#') continue;

            Rule rule;
            rule.baseDir = dirRelative;
            if (line[0] == '!') {
                rule.negate = true;
                line.erase(0, 1);
            }
            if (!line.empty() && line.back() == '/') {
                rule.dirOnly = true;
                line.pop_back();
            }
            if (!line.empty() && line[0] == '/') {
                rule.anchored = true;
                line.erase(0, 1);
            }
            if (line.find('/') != std::string::npos) rule.anchored = true;
            if (line.empty()) continue;

            rule.pattern = line;
            rules_.push_back(std::move(rule));
        }
    }

    bool isIgnored(const std::string& relativePath, bool isDirectory) const {
        bool ignored = false;
        for (const Rule& rule : rules_) {
            if (rule.dirOnly && !isDirectory) continue;

            std::string subject = relativePath;
            if (!rule.baseDir.empty()) {
                const std::string prefix = rule.baseDir + "/";
                if (!startsWith(relativePath, prefix)) continue;
                subject = relativePath.substr(prefix.size());
            }

            bool matched = globMatch(rule.pattern, subject);
            if (!matched && !rule.anchored) {
                matched = globMatch("**/" + rule.pattern, subject);
            }
            // A pattern also ignores everything beneath a matched directory.
            if (!matched) {
                matched = globMatch(rule.pattern + "/**", subject) ||
                          (!rule.anchored && globMatch("**/" + rule.pattern + "/**", subject));
            }
            if (matched) ignored = !rule.negate;
        }
        return ignored;
    }

private:
    struct Rule {
        std::string baseDir;
        std::string pattern;
        bool negate = false;
        bool dirOnly = false;
        bool anchored = false;
    };
    std::vector<Rule> rules_;
};

/// Walks the tree below `root`, pruning ignored directories as it descends.
/// Yields paths relative to `root`.
void walkProjectFiles(const fs::path& root,
                      GitignoreMatcher& matcher,
                      const std::string& relativeDir,
                      const std::function<bool(const std::string&)>& onFile) {
    const fs::path directory = relativeDir.empty() ? root : root / fs::path(toWide(relativeDir));

    bool hasGitignore = false;
    const std::string gitignore = readFileText(directory / L".gitignore", &hasGitignore);
    if (hasGitignore) matcher.add(relativeDir, gitignore);

    std::error_code ec;
    std::vector<fs::directory_entry> entries;
    for (fs::directory_iterator it(directory, fs::directory_options::skip_permission_denied, ec);
         !ec && it != fs::directory_iterator(); it.increment(ec)) {
        entries.push_back(*it);
    }
    // Deterministic order, so truncation always cuts at the same place.
    std::sort(entries.begin(), entries.end(), [](const fs::directory_entry& a, const fs::directory_entry& b) {
        return a.path().filename() < b.path().filename();
    });

    for (const fs::directory_entry& entry : entries) {
        const std::string name = toUtf8(entry.path().filename().wstring());
        if (name.empty() || name[0] == '.') continue; // also covers .git

        std::error_code statusEc;
        if (entry.is_symlink(statusEc)) continue; // never followed: cycles and escapes

        const std::string relative = relativeDir.empty() ? name : relativeDir + "/" + name;

        if (entry.is_directory(statusEc)) {
            if (name == "node_modules") continue;
            if (matcher.isIgnored(relative, true)) continue;
            walkProjectFiles(root, matcher, relative, onFile);
            continue;
        }
        if (!entry.is_regular_file(statusEc)) continue;
        if (matcher.isIgnored(relative, false)) continue;
        if (!onFile(relative)) return;
    }
}

// ---------------------------------------------------------------------------
// Child processes (the bash tool)
// ---------------------------------------------------------------------------

std::wstring quoteArgument(const std::wstring& argument) {
    std::wstring out = L"\"";
    size_t backslashes = 0;
    for (const wchar_t c : argument) {
        if (c == L'\\') {
            ++backslashes;
            continue;
        }
        if (c == L'"') {
            out.append(backslashes * 2 + 1, L'\\');
            out.push_back(L'"');
            backslashes = 0;
            continue;
        }
        out.append(backslashes, L'\\');
        backslashes = 0;
        out.push_back(c);
    }
    out.append(backslashes * 2, L'\\');
    out.push_back(L'"');
    return out;
}

/// Copies the parent environment minus credential-bearing variables, matching
/// the CLI's scrubCredentialEnv: containment, not isolation.
std::wstring scrubbedEnvironmentBlock() {
    static const std::set<std::string> kDenied = {
        "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY",
        "GEMINI_API_KEY", "MOONSHOT_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN", "GCP_SERVICE_ACCOUNT_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
        "AZURE_CLIENT_SECRET", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "POLAR_ACCESS_TOKEN",
        "CLERK_SECRET_KEY", "DATABASE_URL", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
    };
    static const std::vector<std::string> kDeniedSuffixes = {
        "_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_PASSWD",
    };

    std::wstring block;
    LPWCH environment = ::GetEnvironmentStringsW();
    if (!environment) return block;

    for (LPWCH cursor = environment; *cursor; cursor += wcslen(cursor) + 1) {
        const std::wstring entry(cursor);
        const size_t equals = entry.find(L'=');
        if (equals == std::wstring::npos || equals == 0) continue; // drive markers like "=C:"

        std::string name = toUtf8(entry.substr(0, equals));
        std::transform(name.begin(), name.end(), name.begin(),
                       [](unsigned char c) { return static_cast<char>(std::toupper(c)); });

        if (kDenied.count(name) > 0) continue;
        bool deniedBySuffix = false;
        for (const std::string& suffix : kDeniedSuffixes) {
            if (endsWith(name, suffix)) {
                deniedBySuffix = true;
                break;
            }
        }
        if (deniedBySuffix) continue;

        block.append(entry);
        block.push_back(L'\0');
    }
    ::FreeEnvironmentStringsW(environment);
    block.push_back(L'\0');
    return block;
}

struct ProcessOutput {
    std::string out;
    std::string err;
    int exitCode = -1;
    bool timedOut = false;
    std::string failure;
};

void drainPipe(HANDLE pipe, std::string& sink) {
    char buffer[4096];
    DWORD read = 0;
    while (::ReadFile(pipe, buffer, sizeof(buffer), &read, nullptr) && read > 0) {
        sink.append(buffer, read);
    }
}

ProcessOutput runBash(const std::string& bashPath,
                      const std::string& command,
                      const std::string& workingDirectory,
                      int timeoutMs,
                      const std::function<bool()>& cancelled) {
    ProcessOutput result;

    SECURITY_ATTRIBUTES attributes{};
    attributes.nLength = sizeof(attributes);
    attributes.bInheritHandle = TRUE;

    HANDLE outRead = nullptr, outWrite = nullptr, errRead = nullptr, errWrite = nullptr;
    if (!::CreatePipe(&outRead, &outWrite, &attributes, 0) ||
        !::CreatePipe(&errRead, &errWrite, &attributes, 0)) {
        result.failure = "Could not create a pipe for the command output";
        return result;
    }
    ::SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
    ::SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0);

    // Give the child a real (empty) stdin so anything that reads sees EOF
    // instead of blocking until the timeout.
    HANDLE nulHandle = ::CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                     &attributes, OPEN_EXISTING, 0, nullptr);

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = nulHandle;
    startup.hStdOutput = outWrite;
    startup.hStdError = errWrite;

    std::wstring commandLine = quoteArgument(toWide(bashPath)) + L" -c " + quoteArgument(toWide(command));
    std::wstring environment = scrubbedEnvironmentBlock();
    const std::wstring cwd = toWide(workingDirectory);

    PROCESS_INFORMATION process{};
    const BOOL created = ::CreateProcessW(nullptr,
                                          commandLine.data(),
                                          nullptr,
                                          nullptr,
                                          TRUE,
                                          CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                                          environment.empty() ? nullptr : environment.data(),
                                          cwd.empty() ? nullptr : cwd.c_str(),
                                          &startup,
                                          &process);

    ::CloseHandle(outWrite);
    ::CloseHandle(errWrite);
    if (nulHandle) ::CloseHandle(nulHandle);

    if (!created) {
        ::CloseHandle(outRead);
        ::CloseHandle(errRead);
        result.failure = "Could not start bash (Windows error " + std::to_string(::GetLastError()) + ")";
        return result;
    }

    std::thread outReader([&] { drainPipe(outRead, result.out); });
    std::thread errReader([&] { drainPipe(errRead, result.err); });

    const long long deadline = nowMs() + timeoutMs;
    for (;;) {
        const DWORD wait = ::WaitForSingleObject(process.hProcess, 100);
        if (wait == WAIT_OBJECT_0) break;
        if (nowMs() >= deadline) {
            result.timedOut = true;
            ::TerminateProcess(process.hProcess, 1);
            break;
        }
        if (cancelled && cancelled()) {
            ::TerminateProcess(process.hProcess, 1);
            break;
        }
    }

    // Readers finish once the child's handles are closed, which TerminateProcess
    // also guarantees.
    outReader.join();
    errReader.join();
    ::CloseHandle(outRead);
    ::CloseHandle(errRead);

    DWORD exitCode = 0;
    ::GetExitCodeProcess(process.hProcess, &exitCode);
    result.exitCode = static_cast<int>(exitCode);

    ::CloseHandle(process.hThread);
    ::CloseHandle(process.hProcess);
    return result;
}

// ---------------------------------------------------------------------------
// editFile matching
// ---------------------------------------------------------------------------

struct EditOutcome {
    bool ok = false;
    std::string content;
    std::string strategy;
    std::string error;
};

EditOutcome applyExact(const std::string& content, const std::string& oldString, const std::string& newString) {
    EditOutcome outcome;
    const size_t first = content.find(oldString);
    if (first == std::string::npos) {
        outcome.error = "oldString was not found in the file";
        return outcome;
    }
    if (content.find(oldString, first + 1) != std::string::npos) {
        outcome.error = "oldString is not unique in the file — include more surrounding context";
        return outcome;
    }
    outcome.content = content.substr(0, first) + newString + content.substr(first + oldString.size());
    outcome.strategy = "exact";
    outcome.ok = true;
    return outcome;
}

/// Fallback that ignores per-line leading/trailing whitespace, which is what
/// rescues most near-miss quoting by the model. (The CLI has a longer chain;
/// this covers the common case and reports when it was used.)
EditOutcome applyLineTrimmed(const std::string& content, const std::string& oldString, const std::string& newString) {
    EditOutcome outcome;
    const std::vector<std::string> haystack = splitLines(content);
    std::vector<std::string> needle = splitLines(oldString);
    while (!needle.empty() && trim(needle.back()).empty()) needle.pop_back();
    if (needle.empty()) {
        outcome.error = "oldString was not found in the file";
        return outcome;
    }

    std::vector<size_t> starts;
    for (size_t i = 0; i + needle.size() <= haystack.size(); ++i) {
        bool matched = true;
        for (size_t j = 0; j < needle.size(); ++j) {
            if (trim(haystack[i + j]) != trim(needle[j])) {
                matched = false;
                break;
            }
        }
        if (matched) starts.push_back(i);
    }
    if (starts.empty()) {
        outcome.error = "oldString was not found in the file";
        return outcome;
    }
    if (starts.size() > 1) {
        outcome.error = "oldString is not unique in the file — include more surrounding context";
        return outcome;
    }

    // Rebuild with the original line endings preserved around the splice.
    std::vector<std::string> merged;
    merged.reserve(haystack.size());
    for (size_t i = 0; i < starts[0]; ++i) merged.push_back(haystack[i]);
    for (const std::string& line : splitLines(newString)) merged.push_back(line);
    for (size_t i = starts[0] + needle.size(); i < haystack.size(); ++i) merged.push_back(haystack[i]);

    std::string rebuilt;
    for (size_t i = 0; i < merged.size(); ++i) {
        rebuilt += merged[i];
        if (i + 1 < merged.size()) rebuilt += "\n";
    }
    outcome.content = rebuilt;
    outcome.strategy = "line-trimmed";
    outcome.ok = true;
    return outcome;
}

// ---------------------------------------------------------------------------

ToolResult fail(const std::string& message) {
    ToolResult result;
    result.ok = false;
    result.error = message;
    return result;
}

ToolResult succeed(json output) {
    ToolResult result;
    result.ok = true;
    result.output = std::move(output);
    return result;
}

std::string requiredString(const json& input, const char* key, bool& ok) {
    if (!input.is_object() || !input.contains(key) || !input[key].is_string()) {
        ok = false;
        return {};
    }
    return input[key].get<std::string>();
}

std::string optionalString(const json& input, const char* key, const std::string& fallback) {
    if (!input.is_object() || !input.contains(key) || !input[key].is_string()) return fallback;
    return input[key].get<std::string>();
}

} // namespace

void TodoStore::replace(const json& todos) {
    std::lock_guard<std::mutex> lock(mutex_);
    todos_ = todos.is_array() ? todos : json::array();
}

json TodoStore::list() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return todos_;
}

void TodoStore::clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    todos_ = json::array();
}

std::string findBashPath() {
    // Git for Windows is the usual source of bash on a developer machine; WSL's
    // bash.exe is deliberately not used, since it runs in a different filesystem
    // namespace and the project path would not resolve.
    wchar_t buffer[MAX_PATH]{};
    if (::SearchPathW(nullptr, L"bash.exe", nullptr, MAX_PATH, buffer, nullptr) > 0) {
        const std::string found = toUtf8(buffer);
        if (toLower(found).find("\\windows\\system32\\") == std::string::npos) return found;
    }
    static const wchar_t* kCandidates[] = {
        L"C:\\Program Files\\Git\\bin\\bash.exe",
        L"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        L"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    };
    for (const wchar_t* candidate : kCandidates) {
        std::error_code ec;
        if (fs::exists(fs::path(candidate), ec)) return toUtf8(candidate);
    }
    return {};
}

json collectProjectContext(const std::string& projectDir) {
    json context = json::object();

    json environment = json::object();
    environment["cwd"] = projectDir;
    environment["platform"] = "win32";
    environment["osVersion"] = osVersionString();
    environment["date"] = localDateIso();
    const std::string timezone = timezoneName();
    if (!timezone.empty()) environment["timezone"] = timezone;
    environment["bashAvailable"] = !findBashPath().empty();

    // Git state, read straight from .git rather than shelling out — no
    // dependency on git being installed, and no process spawn per turn.
    std::error_code ec;
    const fs::path root(toWide(projectDir));
    const fs::path gitDir = root / L".git";
    if (fs::exists(gitDir, ec)) {
        json git = json::object();
        bool ok = false;
        const std::string head = trim(readFileText(gitDir / L"HEAD", &ok));
        if (ok && !head.empty()) {
            if (startsWith(head, "ref: ")) {
                std::string ref = head.substr(5);
                const size_t lastSlash = ref.find_last_of('/');
                git["branch"] = lastSlash == std::string::npos ? ref : ref.substr(lastSlash + 1);

                bool refOk = false;
                const std::string sha = trim(readFileText(gitDir / fs::path(toWide(ref)), &refOk));
                if (refOk && sha.size() >= 7) git["head"] = sha.substr(0, 7);
            } else if (head.size() >= 7) {
                git["head"] = head.substr(0, 7); // detached HEAD
            }
        }
        if (!git.empty()) environment["git"] = git;
    }
    context["environment"] = environment;

    // AGENTS.md / CLAUDE.md, subject to the shared caps (24k per file, 6 files).
    json instructions = json::array();
    size_t total = 0;
    for (const char* name : {"AGENTS.md", "CLAUDE.md"}) {
        bool ok = false;
        std::string contents = readFileText(root / fs::path(toWide(name)), &ok);
        if (!ok || contents.empty()) continue;

        json entry = json::object();
        entry["path"] = name;
        if (contents.size() > 24000) {
            contents = contents.substr(0, 24000);
            entry["truncated"] = true;
        }
        if (total + contents.size() > 32000) break;
        total += contents.size();
        entry["content"] = contents;
        instructions.push_back(std::move(entry));
        if (instructions.size() >= 6) break;
    }
    if (!instructions.empty()) context["instructions"] = instructions;

    return context;
}

ToolResult executeLocalTool(const std::string& toolName, const json& input, ToolContext& context) {
    if (context.cancelled && context.cancelled()) return fail("Turn stopped");

    if (context.mode == "PLAN" && kPlanModeTools.count(toolName) == 0) {
        return fail("Tool " + toolName + " is not available in PLAN mode");
    }

    const bool autoReads = context.settings ? context.settings->autoApproveReads : true;
    const bool autoWrites = context.settings ? context.settings->autoApproveWrites : false;
    const bool autoBash = context.settings ? context.settings->autoApproveBash : false;

    // ---- todoWrite -------------------------------------------------------
    if (toolName == "todoWrite") {
        if (!input.contains("todos") || !input["todos"].is_array()) {
            return fail("todoWrite requires a `todos` array");
        }
        const json& todos = input["todos"];
        if (todos.size() > kMaxTodos) {
            return fail("Too many tasks: the list is capped at " + std::to_string(kMaxTodos));
        }
        int inProgress = 0, pending = 0, completed = 0;
        for (const auto& todo : todos) {
            if (!todo.is_object() || !todo.contains("content") || !todo.contains("status")) {
                return fail("Each task needs `content` and `status`");
            }
            const std::string content = todo.value("content", std::string());
            const std::string status = todo.value("status", std::string());
            if (content.empty() || content.size() > kMaxTodoContentChars) {
                return fail("Task text must be 1-" + std::to_string(kMaxTodoContentChars) + " characters");
            }
            if (status == "in_progress") ++inProgress;
            else if (status == "completed") ++completed;
            else if (status == "pending") ++pending;
            else return fail("status must be pending, in_progress or completed");
        }
        if (inProgress > 1) return fail("At most one task may be in_progress");

        if (context.todos) context.todos->replace(todos);

        json output = json::object();
        output["todos"] = todos;
        output["total"] = todos.size();
        output["pending"] = pending;
        output["inProgress"] = inProgress;
        output["completed"] = completed;
        return succeed(std::move(output));
    }

    // ---- readFile --------------------------------------------------------
    if (toolName == "readFile") {
        bool ok = true;
        const std::string path = requiredString(input, "path", ok);
        if (!ok) return fail("readFile requires a `path`");

        const ResolvedPath resolved = resolveInsideProject(context.projectDir, path);
        if (!resolved.ok) return fail(resolved.error);

        const PermissionOutcome permission =
            context.permissions->checkRead(resolved.projectRelative, autoReads);
        if (!permission.allowed) return fail(permission.reason);

        bool readOk = false;
        const std::string raw = readFileText(resolved.absolute, &readOk);
        if (!readOk) return fail("Could not read " + resolved.projectRelative);

        std::vector<std::string> lines = splitLines(stripBom(raw));
        if (lines.size() > 1 && lines.back().empty()) lines.pop_back();
        const size_t totalLines = lines.size();

        const long long offset = input.contains("offset") && input["offset"].is_number()
                                     ? input["offset"].get<long long>()
                                     : 1;
        const size_t start = offset > 1 ? static_cast<size_t>(offset - 1) : 0;
        size_t limit = input.contains("limit") && input["limit"].is_number()
                           ? static_cast<size_t>(input["limit"].get<long long>())
                           : kMaxReadLines;
        limit = std::min(limit, kMaxReadLines);

        std::vector<std::string> selected;
        size_t chars = 0;
        bool charBudgetHit = false;
        for (size_t i = start; i < totalLines && selected.size() < limit; ++i) {
            std::string line = lines[i];
            if (line.size() > kMaxLineChars) {
                line = line.substr(0, kMaxLineChars) + "... (line truncated, " +
                       std::to_string(lines[i].size()) + " chars)";
            }
            if (chars + line.size() > kMaxReadChars) {
                charBudgetHit = true;
                break;
            }
            chars += line.size() + 1;
            selected.push_back(std::move(line));
        }

        std::string content;
        for (size_t i = 0; i < selected.size(); ++i) {
            content += selected[i];
            if (i + 1 < selected.size()) content += "\n";
        }

        const size_t nextOffset = start + selected.size() + 1;
        json output = json::object();
        output["content"] = content;
        output["startLine"] = start + 1;
        output["endLine"] = start + selected.size();
        output["totalLines"] = totalLines;
        if (nextOffset <= totalLines) {
            output["truncated"] = true;
            output["nextOffset"] = nextOffset;
            output["hint"] = charBudgetHit
                                 ? "Output size limit reached. Continue with offset: " + std::to_string(nextOffset) + "."
                                 : "Showing " + std::to_string(selected.size()) + " of " +
                                       std::to_string(totalLines) + " lines. Continue with offset: " +
                                       std::to_string(nextOffset) + ".";
        }
        return succeed(std::move(output));
    }

    // ---- listDirectory ---------------------------------------------------
    if (toolName == "listDirectory") {
        const std::string path = optionalString(input, "path", ".");
        const ResolvedPath resolved = resolveInsideProject(context.projectDir, path);
        if (!resolved.ok) return fail(resolved.error);

        std::error_code ec;
        if (!fs::is_directory(resolved.absolute, ec)) return fail("Not a directory: " + resolved.projectRelative);

        struct Entry {
            std::string name;
            bool directory;
        };
        std::vector<Entry> entries;
        for (fs::directory_iterator it(resolved.absolute, fs::directory_options::skip_permission_denied, ec);
             !ec && it != fs::directory_iterator(); it.increment(ec)) {
            const std::string name = toUtf8(it->path().filename().wstring());
            if (name.empty() || name[0] == '.' || name == "node_modules") continue;
            std::error_code statusEc;
            entries.push_back({name, it->is_directory(statusEc)});
        }
        std::sort(entries.begin(), entries.end(), [](const Entry& a, const Entry& b) {
            if (a.directory != b.directory) return a.directory;
            return a.name < b.name;
        });

        json list = json::array();
        for (const Entry& entry : entries) {
            json item = json::object();
            item["name"] = entry.name;
            item["type"] = entry.directory ? "directory" : "file";
            list.push_back(std::move(item));
        }

        json output = json::object();
        output["path"] = resolved.projectRelative;
        output["entries"] = std::move(list);
        return succeed(std::move(output));
    }

    // ---- glob ------------------------------------------------------------
    if (toolName == "glob") {
        bool ok = true;
        const std::string pattern = requiredString(input, "pattern", ok);
        if (!ok) return fail("glob requires a `pattern`");
        const std::string path = optionalString(input, "path", ".");

        const ResolvedPath resolved = resolveInsideProject(context.projectDir, path);
        if (!resolved.ok) return fail(resolved.error);

        std::vector<std::string> files;
        bool truncated = false;
        GitignoreMatcher matcher;
        const std::string prefix = resolved.projectRelative == "." ? "" : resolved.projectRelative + "/";

        walkProjectFiles(resolved.absolute, matcher, "", [&](const std::string& relative) {
            if (!globMatch(pattern, relative)) return true;
            if (files.size() >= kMaxResults) {
                truncated = true;
                return false;
            }
            files.push_back(prefix + relative);
            return true;
        });

        std::sort(files.begin(), files.end());
        json output = json::object();
        output["files"] = files;
        if (truncated) output["truncated"] = true;
        return succeed(std::move(output));
    }

    // ---- grep ------------------------------------------------------------
    if (toolName == "grep") {
        bool ok = true;
        const std::string pattern = requiredString(input, "pattern", ok);
        if (!ok) return fail("grep requires a `pattern`");
        const std::string path = optionalString(input, "path", ".");
        const std::string include = optionalString(input, "include", "");
        const bool ignoreCase = input.contains("ignoreCase") && input["ignoreCase"].is_boolean()
                                    ? input["ignoreCase"].get<bool>()
                                    : false;

        const ResolvedPath resolved = resolveInsideProject(context.projectDir, path);
        if (!resolved.ok) return fail(resolved.error);

        std::regex regex;
        try {
            auto flags = std::regex::ECMAScript;
            if (ignoreCase) flags |= std::regex::icase;
            regex.assign(pattern, flags);
        } catch (const std::regex_error& error) {
            return fail(std::string("Invalid grep pattern: ") + error.what());
        }

        json matches = json::array();
        bool truncated = false;
        size_t filesScanned = 0;
        size_t skippedProtected = 0;
        GitignoreMatcher matcher;
        const std::string prefix = resolved.projectRelative == "." ? "" : resolved.projectRelative + "/";

        walkProjectFiles(resolved.absolute, matcher, "", [&](const std::string& relative) {
            if (context.cancelled && context.cancelled()) return false;
            if (!include.empty() && !globMatch("**/" + include, relative) && !globMatch(include, relative)) {
                return true;
            }
            if (filesScanned >= kMaxGrepFiles) {
                truncated = true;
                return false;
            }
            ++filesScanned;

            const std::string projectRelative = prefix + relative;
            // grep returns file contents, so it is a read like any other: a
            // search for API_KEY would otherwise walk straight past the guard.
            if (PermissionBroker::isReadProtected(projectRelative)) {
                ++skippedProtected;
                return true;
            }

            std::error_code ec;
            const fs::path absolute = resolved.absolute / fs::path(toWide(relative));
            if (fs::file_size(absolute, ec) > kMaxGrepFileBytes || ec) return true;

            bool readOk = false;
            const std::string contents = readFileText(absolute, &readOk);
            if (!readOk) return true;

            const std::vector<std::string> lines = splitLines(contents);
            for (size_t i = 0; i < lines.size(); ++i) {
                if (!std::regex_search(lines[i], regex)) continue;
                if (matches.size() >= kMaxMatches) {
                    truncated = true;
                    return false;
                }
                json match = json::object();
                match["file"] = projectRelative;
                match["line"] = i + 1;
                match["content"] = truncateForModel(lines[i], 1000);
                matches.push_back(std::move(match));
            }
            return true;
        });

        json output = json::object();
        output["matches"] = matches;
        if (matches.empty()) output["message"] = "No matches found";
        if (truncated) output["truncated"] = true;
        if (skippedProtected > 0) output["skippedProtectedFiles"] = skippedProtected;
        return succeed(std::move(output));
    }

    // ---- writeFile -------------------------------------------------------
    if (toolName == "writeFile") {
        bool ok = true;
        const std::string path = requiredString(input, "path", ok);
        const std::string contents = requiredString(input, "content", ok);
        if (!ok) return fail("writeFile requires `path` and `content`");

        const ResolvedPath resolved = resolveInsideProject(context.projectDir, path);
        if (!resolved.ok) return fail(resolved.error);

        const PermissionOutcome permission =
            context.permissions->checkWrite(resolved.projectRelative, contents, autoWrites);
        if (!permission.allowed) return fail(permission.reason);

        std::string error;
        if (!writeFileText(resolved.absolute, contents, error)) {
            return fail(error + ": " + resolved.projectRelative);
        }

        json output = json::object();
        output["success"] = true;
        output["path"] = resolved.projectRelative;
        output["bytesWritten"] = contents.size();
        return succeed(std::move(output));
    }

    // ---- editFile --------------------------------------------------------
    if (toolName == "editFile") {
        bool ok = true;
        const std::string path = requiredString(input, "path", ok);
        const std::string oldString = requiredString(input, "oldString", ok);
        const std::string newString = requiredString(input, "newString", ok);
        if (!ok) return fail("editFile requires `path`, `oldString` and `newString`");

        const ResolvedPath resolved = resolveInsideProject(context.projectDir, path);
        if (!resolved.ok) return fail(resolved.error);

        bool readOk = false;
        const std::string contents = readFileText(resolved.absolute, &readOk);
        if (!readOk) return fail("Could not read " + resolved.projectRelative);

        EditOutcome outcome = applyExact(contents, oldString, newString);
        if (!outcome.ok) {
            EditOutcome fallback = applyLineTrimmed(contents, oldString, newString);
            if (fallback.ok) outcome = fallback;
        }
        if (!outcome.ok) return fail(outcome.error);

        const PermissionOutcome permission =
            context.permissions->checkWrite(resolved.projectRelative, outcome.content, autoWrites);
        if (!permission.allowed) return fail(permission.reason);

        std::string error;
        if (!writeFileText(resolved.absolute, outcome.content, error)) {
            return fail(error + ": " + resolved.projectRelative);
        }

        json output = json::object();
        output["success"] = true;
        output["path"] = resolved.projectRelative;
        // Say so when a fallback rescued the edit: a fuzzy match is the one case
        // where the replaced region might not be the intended one.
        if (outcome.strategy != "exact") output["matchedBy"] = outcome.strategy;
        return succeed(std::move(output));
    }

    // ---- bash ------------------------------------------------------------
    if (toolName == "bash") {
        bool ok = true;
        const std::string command = requiredString(input, "command", ok);
        if (!ok) return fail("bash requires a `command`");

        int timeout = kDefaultBashTimeoutMs;
        if (input.contains("timeout") && input["timeout"].is_number()) {
            timeout = std::clamp(static_cast<int>(input["timeout"].get<long long>()), 1000, 600000);
        }

        const std::string bashPath = findBashPath();
        if (bashPath.empty()) {
            return fail("The bash tool requires `bash` on your PATH. On Windows, install Git for "
                        "Windows (which bundles bash).");
        }

        const PermissionOutcome permission = context.permissions->checkBash(command, autoBash);
        if (!permission.allowed) return fail(permission.reason);

        const ProcessOutput process =
            runBash(bashPath, command, context.projectDir, timeout, context.cancelled);
        if (!process.failure.empty()) return fail(process.failure);

        json output = json::object();
        output["stdout"] = truncateForModel(process.out, kMaxOutput);
        output["stderr"] = truncateForModel(process.err, kMaxOutput);
        output["exitCode"] = process.exitCode;
        if (process.timedOut) output["timedOut"] = true;
        return succeed(std::move(output));
    }

    // ---- web -------------------------------------------------------------
    if (toolName == "webFetch") {
        // `webSearch` runs on the server, so it never reaches this dispatcher.
        // `webFetch` does: it is meant to run on the user's machine so it can
        // reach local dev servers. Not built here yet — say so plainly rather
        // than returning "unknown tool", which reads to the model like a bug it
        // should retry around.
        return fail("webFetch is not available in the DarkCode desktop app yet. "
                    "Ask the user to paste the content, or use the terminal CLI for this.");
    }

    // ---- LSP -------------------------------------------------------------
    if (startsWith(toolName, "lsp")) {
        // The CLI runs a language-server pool; the desktop app does not yet.
        // Returning a tool error (rather than throwing) tells the model to fall
        // back to grep/readFile instead of retrying the same call.
        return fail("Language-server tools are not available in the DarkCode desktop app. "
                    "Use grep, glob or readFile instead.");
    }

    return fail("Unknown tool: " + toolName);
}

} // namespace dc
