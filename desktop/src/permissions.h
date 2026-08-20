// Client-side permission gate.
//
// Same shape as the CLI's engine: a hard deny list that is never promptable
// (secrets, destructive shell commands), a small allow list of read-only
// commands, and a prompt for everything else. Tools run on a worker thread, so
// a prompt parks that thread on a condition variable while the UI thread draws
// the modal and answers.
#pragma once

#include <condition_variable>
#include <mutex>
#include <set>
#include <string>

namespace dc {

enum class PermissionKind { FsRead, FsWrite, Bash };

enum class PermissionDecision { Pending, AllowOnce, AllowSession, Deny };

struct PermissionRequest {
    PermissionKind kind = PermissionKind::FsRead;
    std::string toolName;
    std::string title;   // "Run a shell command"
    std::string subject; // the path or command itself
    std::string detail;  // preview: file contents, replacement text, ...
    std::string sessionLabel; // text for the "always allow" button
};

struct PermissionOutcome {
    bool allowed = false;
    std::string reason; // populated when refused
};

class PermissionBroker {
public:
    /// Worker side. Blocks until the UI answers, or returns immediately when a
    /// rule already decides it.
    PermissionOutcome checkRead(const std::string& projectRelativePath, bool autoApprove);
    PermissionOutcome checkWrite(const std::string& projectRelativePath,
                                 const std::string& preview,
                                 bool autoApprove);
    PermissionOutcome checkBash(const std::string& command, bool autoApprove);

    /// UI side.
    bool hasPending();
    PermissionRequest pending();
    void resolve(PermissionDecision decision);

    /// Denies anything in flight and makes subsequent checks fail fast. Used by
    /// the Stop button so a parked tool thread unwinds immediately.
    void cancelAll();
    void clearCancel();
    void resetSessionGrants();

    /// True when a hard rule refuses the path outright (never promptable).
    static bool isReadProtected(const std::string& projectRelativePath);
    static bool isWriteProtected(const std::string& projectRelativePath);
    /// "allow" / "deny" / "ask" against the default bash policy.
    static const char* classifyBash(const std::string& command);

private:
    PermissionOutcome ask(const PermissionRequest& request);

    std::mutex mutex_;
    std::condition_variable cv_;
    bool hasPending_ = false;
    bool cancelled_ = false;
    PermissionRequest request_;
    PermissionDecision decision_ = PermissionDecision::Pending;

    bool allowAllWrites_ = false;
    bool allowAllReads_ = false;
    std::set<std::string> allowedCommands_; // exact commands approved this session
};

} // namespace dc
