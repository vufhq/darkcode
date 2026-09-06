import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import open from "open";
import { Database } from "bun:sqlite";
import {
  CHATGPT_MODEL_ID, OPENAI_OAUTH_TOKEN_HEADER, OPENAI_OAUTH_ACCOUNT_ID_HEADER,
  assertOAuthServerUrl, isOAuthHeaderValue, type OpenAIOAuthCredentials,
} from "@darkcode/shared";

export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback";
const ISSUER = "https://auth.openai.com";
const RECONNECT = "ChatGPT authorization failed. Reconnect ChatGPT via /keys.";
export type StoredOpenAIOAuth = OpenAIOAuthCredentials & { refreshToken: string; expiresAt: number };

function claims(token: unknown): Record<string, unknown> {
  if (typeof token !== "string") return {};
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return {};
    const value = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function parseOpenAITokens(value: unknown, previous?: StoredOpenAIOAuth, now = Date.now()): StoredOpenAIOAuth {
  if (!value || typeof value !== "object") throw new Error(RECONNECT);
  const data = value as Record<string, unknown>;
  if (data.token_type !== undefined && (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer")) throw new Error(RECONNECT);
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token === undefined ? previous?.refreshToken : data.refresh_token;
  const accessClaims = claims(accessToken);
  const idClaims = claims(data.id_token);
  // Claims only supply routing/expiry hints; OpenAI validates the bearer token.
  const auth = (idClaims["https://api.openai.com/auth"] ?? accessClaims["https://api.openai.com/auth"]) as Record<string, unknown> | undefined;
  const accountId = auth?.chatgpt_account_id ?? previous?.accountId;
  const expiresAt = data.expires_in === undefined
    ? typeof accessClaims.exp === "number" ? accessClaims.exp * 1000 : NaN
    : typeof data.expires_in === "number" && data.expires_in > 0 ? now + data.expires_in * 1000 : NaN;
  if (!isOAuthHeaderValue(accessToken) || !isOAuthHeaderValue(refreshToken) || !isOAuthHeaderValue(accountId) ||
      !Number.isFinite(expiresAt) || expiresAt <= now || (previous && previous.accountId !== accountId)) throw new Error(RECONNECT);
  return { accessToken, refreshToken, accountId, expiresAt };
}

export function createOpenAIOAuthClient(options: {
  directory?: string;
  fetch?: typeof globalThis.fetch;
  openBrowser?: (url: string) => Promise<unknown>;
  timeoutMs?: number;
  lockTimeoutMs?: number;
} = {}) {
  const directory = options.directory ?? join(homedir(), ".darkcode");
  const file = join(directory, "openai-oauth.json");
  const transport = options.fetch ?? globalThis.fetch;
  let refresh: Promise<StoredOpenAIOAuth> | undefined;
  let generation = 0;
  let cancelLogin: (() => void) | undefined;
  let blocked = false;

  async function locked<T>(operation: (database: Database) => Promise<T> | T): Promise<T> {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // This database contains only a revision, never tokens. SQLite's OS lock
    // is released on process death; never steal a live owner's lock by age.
    const database = new Database(join(directory, "openai-oauth-lock.sqlite"));
    const deadline = Date.now() + (options.lockTimeoutMs ?? 45_000);
    try {
      database.exec("PRAGMA busy_timeout = 0");
      while (true) {
        try { database.exec("BEGIN IMMEDIATE"); break; }
        catch (error) {
          if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
          if (Date.now() >= deadline) throw new Error("ChatGPT credentials are busy in another process. Retry shortly.");
          await Bun.sleep(25);
        }
      }
      try {
        database.exec("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL); INSERT OR IGNORE INTO state VALUES (1, 0)");
        return await operation(database);
      } finally {
        // Deletions/invalidation also commit when an OAuth request fails.
        database.exec("COMMIT");
      }
    } finally { database.close(); }
  }
  function storeRevision(database: Database): number {
    return (database.query("SELECT revision FROM state WHERE id = 1").get() as { revision: number }).revision;
  }

  function read(): StoredOpenAIOAuth | null {
    if (blocked) return null;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (!isOAuthHeaderValue(data.accessToken) || !isOAuthHeaderValue(data.refreshToken) || !isOAuthHeaderValue(data.accountId) || !Number.isFinite(data.expiresAt)) return null;
      return data;
    } catch { return null; }
  }
  function save(data: StoredOpenAIOAuth) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: "wx" });
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
  }
  async function disconnect() {
    generation++;
    blocked = true;
    cancelLogin?.();
    return locked((database) => {
      database.exec("UPDATE state SET revision = revision + 1 WHERE id = 1");
      rmSync(file, { force: true });
      return storeRevision(database);
    });
  }
  async function exchange(params: Record<string, string>, signal: AbortSignal, previous?: StoredOpenAIOAuth) {
    try {
      const response = await transport(`${ISSUER}/oauth/token`, {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, client_id: OPENAI_CLIENT_ID }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(RECONNECT); }
      return parseOpenAITokens(await response.json(), previous);
    } catch { throw new Error(RECONNECT); }
  }
  async function credentials(): Promise<StoredOpenAIOAuth> {
    const current = read();
    if (!current) throw new Error(RECONNECT);
    if (current.expiresAt > Date.now() + 60_000) return current;
    if (refresh) return refresh;
    const revision = generation;
    refresh = locked(async (database) => {
      if (revision !== generation) throw new Error(RECONNECT);
      // Another process may have rotated or deleted the credentials while we waited.
      const current = read();
      if (!current) throw new Error(RECONNECT);
      if (current.expiresAt > Date.now() + 60_000) return current;
      try {
        const next = await exchange({ grant_type: "refresh_token", refresh_token: current.refreshToken }, AbortSignal.timeout(30_000), current);
        if (revision !== generation) throw new Error(RECONNECT);
        save(next);
        return next;
      } catch {
        blocked = true;
        database.exec("UPDATE state SET revision = revision + 1 WHERE id = 1");
        rmSync(file, { force: true });
        throw new Error(RECONNECT);
      }
    }).finally(() => { refresh = undefined; });
    return refresh;
  }
  async function connect(signal?: AbortSignal): Promise<void> {
    const persistedRevision = await disconnect();
    const revision = generation;
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, options.timeoutMs ?? 5 * 60_000);
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let consumed = false;
        cancelLogin = abort;
        controller.signal.addEventListener("abort", () => reject(new Error("ChatGPT login cancelled or timed out.")), { once: true });
        if (controller.signal.aborted) { reject(new Error("ChatGPT login cancelled.")); return; }
        try {
          server = Bun.serve({
            hostname: "127.0.0.1", port: 1455,
            async fetch(req) {
              const url = new URL(req.url);
              const reply = (text: string, status = 200) => new Response(text, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain", "Connection": "close" } });
              if (req.method !== "GET" || url.pathname !== "/auth/callback") return reply("Not found", 404);
              if (!["localhost:1455", "127.0.0.1:1455"].includes(req.headers.get("host") ?? "")) return reply("Invalid host", 400);
              const states = url.searchParams.getAll("state");
              const received = Buffer.from(states[0] ?? "");
              if (states.length !== 1 || received.length !== state.length || !timingSafeEqual(received, Buffer.from(state))) return reply("Invalid state", 400);
              if (consumed || controller.signal.aborted) return reply("Login already handled", 409);
              consumed = true;
              const codes = url.searchParams.getAll("code");
              if (url.searchParams.has("error") || codes.length !== 1 || !codes[0]) {
                reject(new Error(RECONNECT)); return reply("ChatGPT authorization failed. Return to DarkCode.", 400);
              }
              try {
                const tokens = await exchange({ grant_type: "authorization_code", code: codes[0], redirect_uri: OPENAI_REDIRECT_URI, code_verifier: verifier }, controller.signal);
                await locked((database) => {
                  if (controller.signal.aborted || revision !== generation || persistedRevision !== storeRevision(database)) throw new Error(RECONNECT);
                  save(tokens);
                  blocked = false;
                });
                resolve();
                return reply("ChatGPT connected. You can close this tab.");
              } catch {
                reject(new Error(RECONNECT)); return reply("ChatGPT authorization failed. Return to DarkCode.", 400);
              }
            },
          });
        } catch { reject(new Error("Cannot bind 127.0.0.1:1455. Close other OAuth login windows and retry.")); return; }
        const url = new URL(`${ISSUER}/oauth/authorize`);
        url.search = new URLSearchParams({ response_type: "code", client_id: OPENAI_CLIENT_ID,
          redirect_uri: OPENAI_REDIRECT_URI, scope: "openid profile email offline_access",
          code_challenge: challenge, code_challenge_method: "S256", state,
          id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "darkcode",
        }).toString();
        void (options.openBrowser ?? open)(url.toString()).catch(() => { reject(new Error("Could not open the browser for ChatGPT login.")); });
      });
    } finally {
      controller.abort();
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (cancelLogin === abort) cancelLogin = undefined;
      // Let the callback response flush before closing keep-alive sockets.
      // Bun's graceful stop can wait indefinitely on these sockets on Windows.
      if (!blocked) await Bun.sleep(50);
      await server?.stop(true);
    }
  }
  return { connect, disconnect, credentials, connected: () => read() !== null };
}

export const openAIOAuth = createOpenAIOAuthClient();

export async function openAIOAuthHeaders(model: string, serverUrl: string): Promise<Record<string, string>> {
  if (model !== CHATGPT_MODEL_ID) return {};
  assertOAuthServerUrl(serverUrl);
  const credentials = await openAIOAuth.credentials();
  return { [OPENAI_OAUTH_TOKEN_HEADER]: credentials.accessToken, [OPENAI_OAUTH_ACCOUNT_ID_HEADER]: credentials.accountId };
}

export const oauthSafeFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (headers.has(OPENAI_OAUTH_TOKEN_HEADER) || headers.has(OPENAI_OAUTH_ACCOUNT_ID_HEADER)) {
    assertOAuthServerUrl(input instanceof Request ? input.url : String(input));
    return fetch(input, { ...init, redirect: "error" });
  }
  return fetch(input, init);
};
