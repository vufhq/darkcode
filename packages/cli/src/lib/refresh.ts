import { clearAuth, getAuth, saveAuth, type AuthData } from "./auth";

const API_URL = process.env.API_URL ?? "http://localhost:3000";

type RefreshResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
};

/**
 * Use the stored refresh token to mint a new access token. Returns null when
 * there is no refresh token, when refresh fails, or when the server rejects.
 * On rejection the local auth is cleared so subsequent calls fail fast and
 * the user knows to /login again.
 *
 * Single-flight: concurrent callers share one in-flight refresh so we don't
 * burn through Clerk's refresh-token rotation on parallel 401s.
 */
let inflight: Promise<AuthData | null> | null = null;

export function refreshAccessToken(): Promise<AuthData | null> {
  if (inflight) return inflight;
  inflight = doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doRefresh(): Promise<AuthData | null> {
  const current = getAuth();
  if (!current?.refreshToken) return null;

  let response: Response;
  try {
    response = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: current.refreshToken }),
    });
  } catch {
    return null;
  }

  if (response.status === 401) {
    clearAuth();
    return null;
  }
  if (!response.ok) return null;

  const data = (await response.json()) as RefreshResponse;
  const next: AuthData = {
    token: data.accessToken,
    // Clerk may or may not rotate the refresh token; keep the old one when omitted.
    refreshToken: data.refreshToken ?? current.refreshToken,
    expiresAt:
      typeof data.expiresInSec === "number"
        ? Date.now() + data.expiresInSec * 1000
        : undefined,
  };
  saveAuth(next);
  return next;
}
