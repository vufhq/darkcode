// Native OAuth Authorization Code + PKCE flow for the desktop application.
#pragma once

#include <atomic>
#include <cstddef>
#include <functional>
#include <string>

#include "config.h"

namespace dc {

struct OAuthResult {
    AuthData auth;
    std::string error;

    bool ok() const { return auth.valid() && error.empty(); }
};

using OAuthStatusSink = std::function<void(const std::string&)>;

/// Pure helpers kept public for compatibility tests against the CLI protocol.
std::string base64UrlEncode(const unsigned char* data, size_t length);
std::string encodeOAuthState(unsigned short port, const std::string& nonce);
bool decodeOAuthState(const std::string& state,
                      unsigned short& port,
                      std::string& nonce,
                      std::string& error);
std::string buildAuthorizationUrl(const std::string& clerkFrontendApi,
                                  const std::string& clientId,
                                  const std::string& apiUrl,
                                  const std::string& state,
                                  const std::string& challenge);

/// Runs synchronously and must be called from a worker thread. The callback
/// listener is bound to 127.0.0.1 and waits up to five minutes.
OAuthResult signInWithBrowser(const std::string& apiUrl,
                              const std::atomic<bool>& cancelled,
                              const OAuthStatusSink& statusSink);

} // namespace dc
