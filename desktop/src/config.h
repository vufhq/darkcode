// On-disk state shared with the DarkCode CLI (~/.darkcode), plus this app's
// own settings file. The CLI owns the login flow; the desktop app reads the
// same auth.json so `darkcode` + /login signs both of them in.
#pragma once

#include <map>
#include <string>

namespace dc {

struct AuthData {
    std::string token;
    std::string refreshToken;
    long long expiresAtMs = 0; // 0 = unknown, treated as "not expired"

    bool valid() const { return !token.empty(); }
};

std::string homeDir();
std::string darkcodeDir();     // %USERPROFILE%\.darkcode
std::string authFilePath();    // ~/.darkcode/auth.json      (shared with the CLI)
std::string apiKeysFilePath(); // ~/.darkcode/api-keys.json  (shared with the CLI)
std::string settingsFilePath();// ~/.darkcode/desktop.json   (this app only)

bool loadAuth(AuthData& out);
void saveAuth(const AuthData& auth);
void clearAuth();
/// Mirrors the CLI's 30s refresh skew so a long stream never races a 401.
bool accessTokenExpired(const AuthData& auth, long long nowMsValue = 0);

std::map<std::string, std::string> loadApiKeys();
void saveApiKeys(const std::map<std::string, std::string>& keys);

/// Modal folder picker. Returns an empty string when the user cancels.
std::string browseForFolder(const std::string& initialDirectory);

struct Settings {
    /// The URL actually used. May come from DARKCODE_API_URL / API_URL.
    std::string apiUrl = "https://api.darkcode.sh";
    /// What the settings file holds. Kept separate so an environment override
    /// is never written back to disk — otherwise pointing the app at a local
    /// server once would silently make that the permanent default.
    std::string apiUrlStored = "https://api.darkcode.sh";
    bool apiUrlFromEnv = false;

    std::string projectDir;              // tools resolve every path against this
    std::string model = "darkcode-ai";
    std::string mode = "BUILD";          // BUILD | PLAN
    bool autoApproveReads = true;        // sensitive files are refused regardless
    bool autoApproveWrites = false;
    bool autoApproveBash = false;
    bool sendProjectContext = true;
    float uiScale = 1.0f;

    void load();
    void save() const;
};

} // namespace dc
