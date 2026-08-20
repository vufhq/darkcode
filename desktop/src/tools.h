// Client-side tool execution.
//
// DarkCode dispatches tools on the client: the server only declares the
// schemas, and whoever is driving the conversation runs them against the real
// filesystem and posts the results back. This is the desktop app's half of
// that contract, matching packages/cli/src/lib/local-tools.ts.
#pragma once

#include <functional>
#include <mutex>
#include <string>
#include <vector>

#include "json.h"
#include "permissions.h"

namespace dc {

struct Settings;

/// The session task list. Owned here, re-sent with every request; the server
/// renders it into the system prompt and never stores it.
class TodoStore {
public:
    void replace(const json& todos);
    json list() const;
    void clear();

private:
    mutable std::mutex mutex_;
    json todos_ = json::array();
};

struct ToolContext {
    std::string projectDir;
    std::string mode = "BUILD";
    const Settings* settings = nullptr;
    PermissionBroker* permissions = nullptr;
    TodoStore* todos = nullptr;
    std::function<bool()> cancelled;
};

struct ToolResult {
    bool ok = false;
    json output;
    std::string error;
};

ToolResult executeLocalTool(const std::string& toolName, const json& input, ToolContext& context);

/// Ambient project context (cwd, platform, git state, AGENTS.md / CLAUDE.md),
/// gathered here because the server never sees the filesystem.
json collectProjectContext(const std::string& projectDir);

/// Absolute path to a usable bash.exe, or empty when none is installed.
std::string findBashPath();

} // namespace dc
