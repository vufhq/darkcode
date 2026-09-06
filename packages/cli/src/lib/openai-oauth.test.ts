import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { assertOAuthServerUrl, OPENAI_OAUTH_TOKEN_HEADER, OPENAI_OAUTH_ACCOUNT_ID_HEADER } from "@darkcode/shared";
import { createOpenAIOAuthClient, parseOpenAITokens, OPENAI_CLIENT_ID, OPENAI_REDIRECT_URI, openAIOAuthHeaders, oauthSafeFetch, openAIOAuth } from "./openai-oauth";

const directories: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "darkcode-oauth-")); directories.push(dir); return dir; }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const jwt = (account = "account-1", exp = Math.floor(Date.now() / 1000) + 3600) => `e30.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.sig`;
const tokens = () => ({ access_token: jwt(), refresh_token: "refresh-secret", id_token: jwt(), expires_in: 3600, token_type: "Bearer" });
const seed = (dir: string) => writeFileSync(join(dir, "openai-oauth.json"), JSON.stringify({ accessToken: jwt(), refreshToken: "refresh-secret", accountId: "account-1", expiresAt: Date.now() - 1 }));

test("token response validation fails closed and supports expiry claims / refresh rotation", () => {
  const initial = parseOpenAITokens(tokens());
  expect(initial.accountId).toBe("account-1");
  expect(parseOpenAITokens({ access_token: jwt() , refresh_token: "rotated" }, initial).refreshToken).toBe("rotated");
  expect(parseOpenAITokens({ access_token: jwt() }, initial).refreshToken).toBe("refresh-secret");
  for (const value of [null, {}, { ...tokens(), access_token: "" }, { ...tokens(), refresh_token: "\nsecret" }, { ...tokens(), expires_in: "3600" }, { ...tokens(), expires_in: -1 }, { ...tokens(), token_type: "Basic" }, { access_token: "opaque", refresh_token: "r" }]) {
    expect(() => parseOpenAITokens(value)).toThrow("authorization failed");
  }
  expect(() => parseOpenAITokens({ ...tokens(), id_token: jwt("other") }, initial)).toThrow();
});

test("browser PKCE login validates state before errors, exchanges once, and saves separately", async () => {
  const dir = directory();
  writeFileSync(join(dir, "api-keys.json"), "untouched");
  let calls = 0;
  let authorize: URL;
  let callback: Promise<Response> | undefined;
  const client = createOpenAIOAuthClient({ directory: dir,
    fetch: (async (url, init) => {
      calls++;
      expect(String(url)).toBe("https://auth.openai.com/oauth/token");
      expect(init?.redirect).toBe("error");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe(OPENAI_CLIENT_ID);
      expect(body.get("redirect_uri")).toBe(OPENAI_REDIRECT_URI);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(authorize.searchParams.get("code_challenge")!);
      const replay = await fetch(`http://127.0.0.1:1455/auth/callback?state=${authorize.searchParams.get("state")}&code=replay`);
      expect(replay.status).toBe(409);
      return Response.json(tokens());
    }) as typeof fetch,
    openBrowser: async (url) => {
      authorize = new URL(url);
      expect(authorize.origin).toBe("https://auth.openai.com");
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      const invalid = await fetch("http://127.0.0.1:1455/auth/callback?state=wrong&error=secret-error");
      expect(invalid.status).toBe(400);
      expect(calls).toBe(0);
      callback = fetch(`http://127.0.0.1:1455/auth/callback?state=${authorize.searchParams.get("state")}&code=test-code`);
      await callback.catch(() => undefined);
    },
  });
  await client.connect();
  expect((await callback)?.status).toBe(200);
  expect(calls).toBe(1);
  expect(client.connected()).toBe(true);
  expect((await client.credentials()).accountId).toBe("account-1");
  expect(readFileSync(join(dir, "api-keys.json"), "utf8")).toBe("untouched");
  if (process.platform !== "win32") expect(statSync(join(dir, "openai-oauth.json")).mode & 0o777).toBe(0o600);
  await client.disconnect();
  expect(client.connected()).toBe(false);
  expect(existsSync(join(dir, "openai-oauth.json"))).toBe(false);
});

test("refresh is single-flight, rotates locally, and never sends a DarkCode request", async () => {
  const dir = directory(); seed(dir);
  let count = 0;
  const client = createOpenAIOAuthClient({ directory: dir, fetch: (async (url, init) => {
    count++;
    expect(String(url)).toBe("https://auth.openai.com/oauth/token");
    expect(init?.redirect).toBe("error");
    expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("refresh-secret");
    await Bun.sleep(10);
    return Response.json({ ...tokens(), refresh_token: "rotated" });
  }) as typeof fetch });
  const values = await Promise.all([client.credentials(), client.credentials(), client.credentials()]);
  expect(count).toBe(1);
  expect(values.every((value) => value.refreshToken === "rotated")).toBe(true);
  expect(JSON.parse(readFileSync(join(dir, "openai-oauth.json"), "utf8")).refreshToken).toBe("rotated");
});

test("refresh failure removes credentials and never leaks the OAuth response body", async () => {
  const dir = directory(); seed(dir);
  const client = createOpenAIOAuthClient({ directory: dir, fetch: (async () => new Response("refresh-secret raw-error", { status: 401 })) as unknown as typeof fetch });
  await expect(client.credentials()).rejects.toThrow("ChatGPT authorization failed. Reconnect ChatGPT via /keys.");
  expect(client.connected()).toBe(false);
  expect(existsSync(join(dir, "openai-oauth.json"))).toBe(false);
  await expect(client.credentials()).rejects.toThrow("authorization failed");
});

test("disconnect during refresh cannot resurrect credentials", async () => {
  const dir = directory(); seed(dir);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const client = createOpenAIOAuthClient({ directory: dir, fetch: (async () => { await wait; return Response.json(tokens()); }) as unknown as typeof fetch });
  const request = client.credentials();
  const disconnect = client.disconnect(); release();
  await expect(request).rejects.toThrow("authorization failed");
  await disconnect;
  expect(existsSync(join(dir, "openai-oauth.json"))).toBe(false);
});

test("cancellation and timeout release the loopback port without credentials", async () => {
  for (const timeout of [false, true]) {
    const dir = directory();
    const controller = new AbortController();
    const client = createOpenAIOAuthClient({ directory: dir, timeoutMs: 20, openBrowser: async () => { if (!timeout) controller.abort(); } });
    await expect(client.connect(controller.signal)).rejects.toThrow("cancelled");
    expect(client.connected()).toBe(false);
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 1455, fetch: () => new Response() });
    await listener.stop(true);
  }
});

test("OAuth callback and token errors are sanitized", async () => {
  const client = createOpenAIOAuthClient({ directory: directory(), openBrowser: async (url) => {
    const state = new URL(url).searchParams.get("state");
    await fetch(`http://127.0.0.1:1455/auth/callback?state=${state}&error=raw-secret&error_description=raw-secret`).catch(() => undefined);
  } });
  await expect(client.connect()).rejects.toThrow("ChatGPT authorization failed. Reconnect ChatGPT via /keys.");
});

test("only OAuth model requests credentials and insecure servers are rejected before access", async () => {
  expect(await openAIOAuthHeaders("gpt-5.4", "http://untrusted.test")).toEqual({});
  await expect(openAIOAuthHeaders("chatgpt-gpt-5.4", "http://untrusted.test")).rejects.toThrow("HTTPS");
  for (const url of ["https://example.com", "http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) expect(() => assertOAuthServerUrl(url)).not.toThrow();
  for (const url of ["http://localhost.evil", "http://192.168.1.1", "https://user:secret@example.com", "ftp://localhost"]) expect(() => assertOAuthServerUrl(url)).toThrow();
});

test("OAuth-bearing requests never follow redirects", async () => {
  let leaked = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { leaked++; return new Response(); } });
  const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect(target.url.toString(), 307) });
  try {
    await expect(oauthSafeFetch(redirect.url, { headers: { [OPENAI_OAUTH_TOKEN_HEADER]: "test-secret" } })).rejects.toThrow();
    expect(leaked).toBe(0);
  } finally { await redirect.stop(true); await target.stop(true); }
});

test("chat and compaction headers forward only access token and account ID on the OAuth model", async () => {
  const spy = spyOn(openAIOAuth, "credentials").mockResolvedValue(parseOpenAITokens(tokens()));
  try {
    for (const path of ["chat", "sessions/test/compact"]) {
      const headers = await openAIOAuthHeaders("chatgpt-gpt-5.4", `https://darkcode.test/${path}`);
      expect(Object.keys(headers).sort()).toEqual([OPENAI_OAUTH_ACCOUNT_ID_HEADER, OPENAI_OAUTH_TOKEN_HEADER].sort());
      expect(headers[OPENAI_OAUTH_ACCOUNT_ID_HEADER]).toBe("account-1");
      expect(JSON.stringify(headers)).not.toContain("refresh-secret");
    }
    expect(await openAIOAuthHeaders("gpt-5.4", "https://darkcode.test/chat")).toEqual({});
    expect(spy).toHaveBeenCalledTimes(2);
  } finally { spy.mockRestore(); }
});

test("cancellation during token exchange cannot persist a late result", async () => {
  const dir = directory();
  const controller = new AbortController();
  const client = createOpenAIOAuthClient({ directory: dir,
    fetch: (async () => { controller.abort(); await Bun.sleep(10); return Response.json(tokens()); }) as unknown as typeof fetch,
    openBrowser: async (url) => {
      const state = new URL(url).searchParams.get("state");
      await fetch(`http://127.0.0.1:1455/auth/callback?state=${state}&code=test`).catch(() => undefined);
    },
  });
  await expect(client.connect(controller.signal)).rejects.toThrow("cancelled");
  await Bun.sleep(20);
  expect(client.connected()).toBe(false);
  expect(existsSync(join(dir, "openai-oauth.json"))).toBe(false);
});

test("distinct clients reread rotated credentials under the mutation lock", async () => {
  const dir = directory(); seed(dir);
  let calls = 0;
  const transport = (async () => {
    calls++;
    await Bun.sleep(50);
    return calls === 1 ? Response.json({ ...tokens(), refresh_token: "winner" }) : new Response("already rotated", { status: 401 });
  }) as unknown as typeof fetch;
  const first = createOpenAIOAuthClient({ directory: dir, fetch: transport });
  const second = createOpenAIOAuthClient({ directory: dir, fetch: transport });
  const results = await Promise.all([first.credentials(), second.credentials()]);
  expect(calls).toBe(1);
  expect(results.map((result) => result.refreshToken)).toEqual(["winner", "winner"]);
  expect(first.connected()).toBe(true);
  expect(second.connected()).toBe(true);
});

test("live lock timeout fails closed without deleting the owner's credentials", async () => {
  const dir = directory(); seed(dir);
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const owner = createOpenAIOAuthClient({ directory: dir, fetch: (async () => {
    started(); await pending; return Response.json(tokens());
  }) as unknown as typeof fetch });
  const request = owner.credentials();
  await entered;
  try {
    const waiter = createOpenAIOAuthClient({ directory: dir, lockTimeoutMs: 30 });
    await expect(waiter.credentials()).rejects.toThrow("busy in another process");
    expect(existsSync(join(dir, "openai-oauth.json"))).toBe(true);
  } finally { release(); await request; }
});

test("separate processes serialize refresh, and disconnect cannot be undone by pending refresh", async () => {
  for (const disconnect of [false, true]) {
    const dir = directory(); seed(dir);
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
      calls++; started();
      await pending;
      return calls === 1 ? Response.json({ ...tokens(), refresh_token: "process-winner" }) : new Response("rotated", { status: 401 });
    } });
    const source = `
      import { createOpenAIOAuthClient } from ${JSON.stringify(new URL("./openai-oauth.ts", import.meta.url).href)};
      const client = createOpenAIOAuthClient({ directory: ${JSON.stringify(dir)},
        fetch: (_url, init) => fetch(${JSON.stringify(server.url.toString())}, init) });
    `;
    const first = Bun.spawn([process.execPath, "-e", `${source} await client.credentials();`], { stdout: "pipe", stderr: "pipe" });
    try {
      await entered;
      const second = Bun.spawn([process.execPath, "-e", `${source}
        const operation = client.${disconnect ? "disconnect" : "credentials"}();
        process.stdout.write("waiting"); await operation;
      `], { stdout: "pipe", stderr: "pipe" });
      try {
        const reader = second.stdout.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("waiting");
        reader.releaseLock();
        release();
        expect(await first.exited).toBe(0);
        expect(await new Response(first.stderr).text()).toBe("");
        expect(await second.exited).toBe(0);
        expect(await new Response(second.stderr).text()).toBe("");
        expect(calls).toBe(1);
        expect(existsSync(join(dir, "openai-oauth.json"))).toBe(!disconnect);
        if (!disconnect) expect(JSON.parse(readFileSync(join(dir, "openai-oauth.json"), "utf8")).refreshToken).toBe("process-winner");
      } finally { second.kill(); await second.exited; }
    } finally { release(); first.kill(); await first.exited; await server.stop(true); }
  }
});

test("a crashed lock owner is recovered by SQLite without stealing live locks", async () => {
  const dir = directory(); seed(dir);
  const child = Bun.spawn([process.execPath, "-e", `
    import { createOpenAIOAuthClient } from ${JSON.stringify(new URL("./openai-oauth.ts", import.meta.url).href)};
    const client = createOpenAIOAuthClient({ directory: ${JSON.stringify(dir)}, fetch: async () => {
      process.stdout.write("locked"); await Bun.sleep(60000); throw new Error("unreachable");
    } });
    await client.credentials();
  `], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("locked");
    reader.releaseLock();
  } finally { child.kill(); await child.exited; }
  const client = createOpenAIOAuthClient({ directory: dir, lockTimeoutMs: 500,
    fetch: (async () => Response.json(tokens())) as unknown as typeof fetch });
  expect((await client.credentials()).accountId).toBe("account-1");
});

test("another client's disconnect invalidates a pending browser login", async () => {
  const dir = directory();
  const other = createOpenAIOAuthClient({ directory: dir });
  const client = createOpenAIOAuthClient({ directory: dir,
    fetch: (async () => { await other.disconnect(); return Response.json(tokens()); }) as unknown as typeof fetch,
    openBrowser: async (url) => {
      const state = new URL(url).searchParams.get("state");
      await fetch(`http://127.0.0.1:1455/auth/callback?state=${state}&code=test`).catch(() => undefined);
    },
  });
  await expect(client.connect()).rejects.toThrow("authorization failed");
  expect(existsSync(join(dir, "openai-oauth.json"))).toBe(false);
});

test("compact command sends the selected summarizer and matching OAuth headers after switching models", async () => {
  // Isolate UI/network module mocks from the other test suites.
  const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const child = Bun.spawn([process.execPath, "-e", `
    import { mock } from "bun:test";
    import { strict as assert } from "node:assert";
    mock.module(${moduleUrl("../components/dialogs/index.ts")}, () => ({}));
    mock.module(${moduleUrl("./oauth.ts")}, () => ({ performLogin() {} }));
    mock.module(${moduleUrl("./auth.ts")}, () => ({ clearAuth() {} }));
    mock.module(${moduleUrl("./upgrade.ts")}, () => ({ openBillingPortal() {}, openProCheckout() {}, openUpgradeCheckout() {} }));
    const requests = [];
    mock.module(${moduleUrl("./api-client.ts")}, () => ({ apiClient: { sessions: { ":id": { compact: {
      $url: () => new URL("https://darkcode.test/sessions/test/compact"),
      $post: async (body, options) => { requests.push({ body, options }); return Response.json({ compacted: false }); }
    } } } } }));
    const { openAIOAuth } = await import(${moduleUrl("./openai-oauth.ts")});
    openAIOAuth.credentials = async () => ({ accessToken: "access", accountId: "account", refreshToken: "refresh", expiresAt: Date.now() + 3600000 });
    const { COMMANDS } = await import(${moduleUrl("../components/command-menu/commands.tsx")});
    const compact = COMMANDS.find(command => command.name === "compact");
    for (const model of ["chatgpt-gpt-5.4", "gpt-5.4", "darkcode-ai"]) {
      await compact.action({ model, sessionId: "test", toast: { show() {} } });
    }
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(request => request.body.json), [
      { summarizerModel: "chatgpt-gpt-5.4" }, { summarizerModel: "gpt-5.4" }, { summarizerModel: "darkcode-ai" }
    ]);
    assert.equal(requests[0].options.headers["x-darkcode-openai-oauth-token"], "access");
    assert.deepEqual(requests[1].options.headers, {});
    assert.deepEqual(requests[2].options.headers, {});
  `], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});
