#include "config.h"

#include <windows.h>
#include <shlobj.h>
#include <shobjidl.h>

#include <filesystem>
#include <fstream>
#include <sstream>

#include "json.h"
#include "util.h"

namespace fs = std::filesystem;

namespace dc {
namespace {

// The CLI refreshes 30s early to avoid racing a 401 mid-stream; match it.
constexpr long long kRefreshSkewMs = 30'000;

std::string readWholeFile(const std::string& path) {
    std::ifstream in(fs::path(toWide(path)), std::ios::binary);
    if (!in) return {};
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

bool writeWholeFile(const std::string& path, const std::string& contents) {
    std::error_code ec;
    fs::create_directories(fs::path(toWide(path)).parent_path(), ec);
    std::ofstream out(fs::path(toWide(path)), std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out.write(contents.data(), static_cast<std::streamsize>(contents.size()));
    return out.good();
}

json parseOrEmpty(const std::string& raw) {
    if (raw.empty()) return json::object();
    json parsed = json::parse(raw, nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object()) return json::object();
    return parsed;
}

std::string envOrEmpty(const wchar_t* name) {
    wchar_t buffer[2048];
    const DWORD length = ::GetEnvironmentVariableW(name, buffer, static_cast<DWORD>(std::size(buffer)));
    if (length == 0 || length >= std::size(buffer)) return {};
    return toUtf8(std::wstring(buffer, length));
}

std::string stripTrailingSlashes(std::string value) {
    while (!value.empty() && (value.back() == '/' || value.back() == '\\')) value.pop_back();
    return value;
}

/// Where the tools point on a first run.
///
/// The working directory is right when the app is started from a terminal
/// inside a project, and useless when it is started from Explorer or a Start
/// menu shortcut — there it is the folder holding the .exe. Detect that case
/// and fall back to the home directory rather than silently rooting the agent
/// in its own install folder.
std::string defaultProjectDir() {
    std::error_code ec;
    const fs::path cwd = fs::current_path(ec);
    if (ec) return homeDir();

    wchar_t exePath[MAX_PATH]{};
    if (::GetModuleFileNameW(nullptr, exePath, MAX_PATH) > 0) {
        const fs::path exeDir = fs::path(exePath).parent_path();
        std::error_code compareEc;
        if (fs::equivalent(cwd, exeDir, compareEc) && !compareEc) return homeDir();
    }
    return toUtf8(cwd.wstring());
}

} // namespace

std::string homeDir() {
    PWSTR path = nullptr;
    if (SUCCEEDED(::SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &path))) {
        std::string result = toUtf8(path);
        ::CoTaskMemFree(path);
        return result;
    }
    const std::string fallback = envOrEmpty(L"USERPROFILE");
    return fallback.empty() ? std::string(".") : fallback;
}

std::string darkcodeDir() { return homeDir() + "\\.darkcode"; }
std::string authFilePath() { return darkcodeDir() + "\\auth.json"; }
std::string apiKeysFilePath() { return darkcodeDir() + "\\api-keys.json"; }
std::string settingsFilePath() { return darkcodeDir() + "\\desktop.json"; }

bool loadAuth(AuthData& out) {
    const json parsed = parseOrEmpty(readWholeFile(authFilePath()));
    if (!parsed.contains("token") || !parsed["token"].is_string()) return false;
    out.token = parsed["token"].get<std::string>();
    out.refreshToken = parsed.value("refreshToken", std::string());
    // The CLI writes epoch milliseconds; tolerate a missing field.
    out.expiresAtMs = parsed.contains("expiresAt") && parsed["expiresAt"].is_number()
                          ? parsed["expiresAt"].get<long long>()
                          : 0;
    return !out.token.empty();
}

void saveAuth(const AuthData& auth) {
    json out = json::object();
    out["token"] = auth.token;
    if (!auth.refreshToken.empty()) out["refreshToken"] = auth.refreshToken;
    if (auth.expiresAtMs > 0) out["expiresAt"] = auth.expiresAtMs;
    writeWholeFile(authFilePath(), out.dump());
}

void clearAuth() {
    std::error_code ec;
    fs::remove(fs::path(toWide(authFilePath())), ec);
}

bool accessTokenExpired(const AuthData& auth, long long nowMsValue) {
    if (auth.expiresAtMs <= 0) return false;
    const long long now = nowMsValue > 0 ? nowMsValue : nowMs();
    return auth.expiresAtMs - kRefreshSkewMs <= now;
}

std::map<std::string, std::string> loadApiKeys() {
    std::map<std::string, std::string> keys;
    const json parsed = parseOrEmpty(readWholeFile(apiKeysFilePath()));
    for (auto it = parsed.begin(); it != parsed.end(); ++it) {
        if (it.value().is_string()) {
            const std::string value = it.value().get<std::string>();
            if (!value.empty()) keys[it.key()] = value;
        }
    }
    return keys;
}

void saveApiKeys(const std::map<std::string, std::string>& keys) {
    json out = json::object();
    for (const auto& [provider, key] : keys) {
        if (!key.empty()) out[provider] = key;
    }
    writeWholeFile(apiKeysFilePath(), out.dump(2));
}

std::string browseForFolder(const std::string& initialDirectory) {
    IFileDialog* dialog = nullptr;
    if (FAILED(::CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(&dialog)))) {
        return {};
    }

    std::string chosen;
    DWORD options = 0;
    if (SUCCEEDED(dialog->GetOptions(&options))) {
        dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    }
    dialog->SetTitle(L"Choose the project directory");

    if (!initialDirectory.empty()) {
        IShellItem* start = nullptr;
        if (SUCCEEDED(::SHCreateItemFromParsingName(toWide(initialDirectory).c_str(), nullptr,
                                                    IID_PPV_ARGS(&start)))) {
            dialog->SetFolder(start);
            start->Release();
        }
    }

    if (SUCCEEDED(dialog->Show(nullptr))) {
        IShellItem* item = nullptr;
        if (SUCCEEDED(dialog->GetResult(&item))) {
            PWSTR path = nullptr;
            if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) {
                chosen = toUtf8(path);
                ::CoTaskMemFree(path);
            }
            item->Release();
        }
    }
    dialog->Release();
    return chosen;
}

void Settings::load() {
    const json parsed = parseOrEmpty(readWholeFile(settingsFilePath()));

    apiUrlStored = stripTrailingSlashes(parsed.value("apiUrl", apiUrlStored));
    projectDir = parsed.value("projectDir", projectDir);
    model = parsed.value("model", model);
    mode = parsed.value("mode", mode);
    autoApproveReads = parsed.value("autoApproveReads", autoApproveReads);
    autoApproveWrites = parsed.value("autoApproveWrites", autoApproveWrites);
    autoApproveBash = parsed.value("autoApproveBash", autoApproveBash);
    autoApproveWeb = parsed.value("autoApproveWeb", autoApproveWeb);
    sendProjectContext = parsed.value("sendProjectContext", sendProjectContext);
    uiScale = parsed.value("uiScale", uiScale);

    // Environment wins over the stored value, matching the CLI's config.ts, so
    // pointing both at a local server is one variable rather than two edits.
    std::string fromEnv = envOrEmpty(L"DARKCODE_API_URL");
    if (fromEnv.empty()) fromEnv = envOrEmpty(L"API_URL");
    apiUrlFromEnv = !fromEnv.empty();
    apiUrl = stripTrailingSlashes(apiUrlFromEnv ? fromEnv : apiUrlStored);

    if (projectDir.empty()) projectDir = defaultProjectDir();
    if (mode != "PLAN" && mode != "BUILD") mode = "BUILD";
    if (uiScale < 0.75f || uiScale > 2.5f) uiScale = 1.0f;
}

void Settings::save() const {
    json out = json::object();
    out["apiUrl"] = apiUrlStored; // never the environment override
    out["projectDir"] = projectDir;
    out["model"] = model;
    out["mode"] = mode;
    out["autoApproveReads"] = autoApproveReads;
    out["autoApproveWrites"] = autoApproveWrites;
    out["autoApproveBash"] = autoApproveBash;
    out["autoApproveWeb"] = autoApproveWeb;
    out["sendProjectContext"] = sendProjectContext;
    out["uiScale"] = uiScale;
    writeWholeFile(settingsFilePath(), out.dump(2));
}

} // namespace dc
