import open from "open";
import { API_URL } from "./config";
import { saveAuth } from "./auth";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

type OAuthConfig = {
  clerkFrontendApi: string;
  clientId: string;
};

/**
 * Resolve the public Clerk OAuth params the PKCE flow needs. The distributed
 * binary bakes in only the API URL, so these are fetched from the server's
 * `GET /auth/config`. An explicit `CLERK_*` env pair takes precedence so local
 * dev can target a different Clerk instance without a running config endpoint.
 */
async function loadOAuthConfig(): Promise<OAuthConfig> {
  const envFrontendApi = process.env.CLERK_FRONTEND_API;
  const envClientId = process.env.CLERK_OAUTH_CLIENT_ID;
  if (envFrontendApi && envClientId) {
    return { clerkFrontendApi: envFrontendApi, clientId: envClientId };
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}/auth/config`);
  } catch {
    throw new Error(`Could not reach the DarkCode API at ${API_URL}. Check your connection and try again.`);
  }
  if (!res.ok) {
    throw new Error(`Failed to load sign-in config from ${API_URL} (HTTP ${res.status}).`);
  }

  const data = (await res.json()) as Partial<OAuthConfig>;
  if (!data.clerkFrontendApi || !data.clientId) {
    throw new Error("Sign-in config from the server is incomplete. The API may be misconfigured.");
  }
  return { clerkFrontendApi: data.clerkFrontendApi, clientId: data.clientId };
}

type OAuthState = {
  nonce: string;
  port: number;
};

function toBase64Url(input: Uint8Array | string) {
  return Buffer.from(input).toString("base64url");
}

async function createPkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

function encodeState(state: OAuthState) {
  return toBase64Url(JSON.stringify(state));
}

function decodeState(state: string) {
  const [encoded] = state.split(".");
  if (!encoded) {
    throw new Error("Invalid state");
  }

  return JSON.parse(Buffer.from(encoded, "base64url").toString()) as OAuthState;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function performLogin() {
  const apiUrl = API_URL;
  const { clerkFrontendApi, clientId } = await loadOAuthConfig();

  const nonce = crypto.randomUUID();
  const codeVerifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = await createPkceChallenge(codeVerifier);

  let settled = false;

  return new Promise<{ token: string }>((resolve, reject) => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname !== "/callback") {
          return new Response("Not found", { status: 404 });
        }

        const error = url.searchParams.get("error");

        if (error) {
          const msg = url.searchParams.get("error_description") ?? error;
          settled = true;
          reject(new Error(msg));
          setTimeout(() => server.stop(), 500);
          return new Response(`Authentication failed: ${msg}`, { status: 400 });
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (!code || !state) {
          settled = true;
          reject(new Error("Missing code or state"));
          setTimeout(() => server.stop(), 500);
          return new Response("Bad request", { status: 400 });
        }

        // Verify nonce from state
        try {
          const payload = decodeState(state);

          if (payload.nonce !== nonce) throw new Error("State mismatch");
        } catch (err) {
          settled = true;
          reject(err);
          setTimeout(() => server.stop(), 500);
          return new Response("Invalid state", { status: 400 });
        }

        try {
          // Exchange authorization code for Clerk tokens
          const redirectUri = `${apiUrl}/auth/callback`;

          const tokenRes = await fetch(`${clerkFrontendApi}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
              client_id: clientId,
              code_verifier: codeVerifier,
            }),
          });

          if (!tokenRes.ok) {
            const details = await tokenRes.text();
            throw new Error(details || "Failed to exchange authorization code");
          }

          const tokenData = (await tokenRes.json()) as {
            access_token: string;
            refresh_token?: string;
            expires_in?: number;
          };

          settled = true;
          saveAuth({
            token: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt:
              typeof tokenData.expires_in === "number"
                ? Date.now() + tokenData.expires_in * 1000
                : undefined,
          });
          resolve({ token: tokenData.access_token });
          setTimeout(() => server.stop(), 500);
          return new Response("Authenticated! You can close this tab.");
        } catch (err) {
          settled = true;
          reject(err);
          const message = getErrorMessage(err);
          setTimeout(() => server.stop(), 500);
          return new Response(`Authentication failed: ${message}`, { status: 400 });
        }
      },
    });

    // Build state with port and nonce
    const port = server.port;
    if (typeof port !== "number") {
      server.stop();
      reject(new Error("Failed to start callback server"));
      return;
    }

    const state = encodeState({ port, nonce });
    const redirectUri = `${apiUrl}/auth/callback`;

    const authorizeUrl = new URL(`${clerkFrontendApi}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    // offline_access is required for Clerk to return a refresh_token.
    authorizeUrl.searchParams.set("scope", "openid email profile offline_access");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("prompt", "login");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    void open(authorizeUrl.toString());

    setTimeout(() => {
      if (!settled) {
        settled = true;
        server.stop();
        reject(new Error("Login timed out"));
      }
    }, LOGIN_TIMEOUT_MS)
  });
}
