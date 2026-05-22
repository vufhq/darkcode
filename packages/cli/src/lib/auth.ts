import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AuthData = {
  token: string;
  refreshToken?: string;
  /** Epoch milliseconds at which `token` stops being valid. Optional for
   *  back-compat with installs that only stored the access token. */
  expiresAt?: number;
};

const AUTH_DIR = join(homedir(), ".darkcode");
const AUTH_FILE = join(AUTH_DIR, "auth.json");

// Refresh proactively while we still have a few seconds of headroom — avoids
// the "race a 401 during a long stream" footgun.
const REFRESH_SKEW_MS = 30_000;

export function getAuth(): AuthData | null {
  try {
    const data = readFileSync(AUTH_FILE, "utf-8");
    const parsed = JSON.parse(data) as Partial<AuthData>;
    if (typeof parsed.token !== "string") return null;
    return {
      token: parsed.token,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined,
    };
  } catch {
    return null;
  }
}

export function saveAuth(data: AuthData) {
  if (!existsSync(AUTH_DIR)) {
    // Owner-only permissions (rwx------) so other users on the machine can't read tokens
    mkdirSync(AUTH_DIR, { mode: 0o700 });
  }
  writeFileSync(AUTH_FILE, JSON.stringify(data), { mode: 0o600 });
}

export function clearAuth() {
  try {
    unlinkSync(AUTH_FILE);
  } catch {
    // File doesn't exist
  }
}

export function isAccessTokenExpired(auth: AuthData, nowMs: number = Date.now()): boolean {
  if (typeof auth.expiresAt !== "number") return false;
  return auth.expiresAt - REFRESH_SKEW_MS <= nowMs;
}
