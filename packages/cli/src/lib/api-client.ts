import { hc } from "hono/client";
import type { AppType } from "@darkcode/server";
import { clearAuth, getAuth, isAccessTokenExpired } from "./auth";
import { refreshAccessToken } from "./refresh";

function applyAuthHeader(headers: Headers, token: string | null) {
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  } else {
    headers.delete("Authorization");
  }
}

export const apiClient = hc<AppType>(
  process.env.API_URL ?? "http://localhost:3000",
  {
    fetch: async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const headers = new Headers(init?.headers);
      let auth = getAuth();

      // Proactively refresh before sending if the access token is past its
      // expiry. Saves a wasted round trip + 401 + retry on a stale token.
      if (auth && isAccessTokenExpired(auth)) {
        const refreshed = await refreshAccessToken();
        auth = refreshed ?? auth;
      }

      applyAuthHeader(headers, auth?.token ?? null);

      let response = await fetch(input, { ...init, headers });

      // Reactive refresh: if the server rejected with 401, try a single
      // refresh and replay the request once. Clearing local auth on a final
      // 401 preserves the prior behavior for the user.
      if (response.status === 401 && auth?.refreshToken) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          applyAuthHeader(headers, refreshed.token);
          response = await fetch(input, { ...init, headers });
        }
      }

      if (response.status === 401) {
        clearAuth();
      }

      return response;
    },
  },
);

/** Best-effort server-side revocation. Always clears the local auth file. */
export async function logout() {
  const auth = getAuth();
  try {
    if (auth) {
      await apiClient.auth.logout.$post();
    }
  } catch {
    // Network/server issues should never block the user from logging out
    // locally — clearing the file below is what actually signs them out.
  } finally {
    clearAuth();
  }
}
