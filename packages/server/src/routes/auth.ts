import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { env } from "../lib/env";
import { logAuditEvent } from "../lib/audit";
import { requireAuth, type AuthenticatedEnv } from "../middleware/require-auth";

const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

const refreshValidator = zValidator("json", refreshSchema, (result, c) => {
  if (!result.success) return c.json({ error: "Invalid request body" }, 400);
});

const app = new Hono<AuthenticatedEnv>()
  // Public OAuth parameters the CLI needs to start the PKCE browser flow,
  // before the user is authenticated. Only public values are exposed here —
  // never CLERK_OAUTH_CLIENT_SECRET. This lets the shipped CLI binary bake in
  // just the API URL and source Clerk config from the server (single source of
  // truth), so rotating Clerk config never requires a CLI rebuild.
  .get("/config", (c) =>
    c.json({
      clerkFrontendApi: env.CLERK_FRONTEND_API,
      clientId: env.CLERK_OAUTH_CLIENT_ID,
    }),
  )
  .get("/callback", (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    const errorDescription = c.req.query("error_description");

    if (error) return c.text(errorDescription ?? error, 400);
    if (!code || !state) return c.text("Missing authorization code or state", 400);

    try {
      const [encoded] = state.split(".");
      if (!encoded) throw new Error("Invalid state");

      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
      const port = payload.port;
      if (!port || typeof port !== "number") throw new Error("Invalid port in state");

      const redirectUrl = `http://localhost:${port}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      return c.redirect(redirectUrl);
    } catch {
      return c.text("Invalid authentication state", 400);
    }
  })
  // Server-side proxy for refresh_token grant. Keeps CLERK_OAUTH_CLIENT_SECRET
  // on the server (the CLI is a public PKCE client without a secret).
  .post("/refresh", refreshValidator, async (c) => {
    const log = c.get("log");
    const { refresh_token } = c.req.valid("json");

    const response = await fetch(`${env.CLERK_FRONTEND_API}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token,
        client_id: env.CLERK_OAUTH_CLIENT_ID,
        client_secret: env.CLERK_OAUTH_CLIENT_SECRET,
      }),
    });

    if (!response.ok) {
      log.warn({ status: response.status }, "auth.refresh_failed");
      return c.json({ error: "Refresh failed. Run /login to continue." }, 401);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    return c.json({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresInSec: data.expires_in,
    });
  })
  // Authenticated logout. Revokes the access token at Clerk (best-effort) and
  // records an audit event. CLI is responsible for clearing local auth too.
  .post("/logout", requireAuth, async (c) => {
    const userId = c.get("userId");
    const requestId = c.get("requestId");
    const log = c.get("log");

    const authHeader = c.req.header("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

    if (token) {
      try {
        const response = await fetch(`${env.CLERK_FRONTEND_API}/oauth/token/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token,
            client_id: env.CLERK_OAUTH_CLIENT_ID,
            client_secret: env.CLERK_OAUTH_CLIENT_SECRET,
          }),
        });
        if (!response.ok) {
          log.warn({ status: response.status }, "auth.revoke_non_200");
        }
      } catch (error) {
        log.warn({ err: error }, "auth.revoke_threw");
      }
    }

    await logAuditEvent({ userId, action: "auth.logout", requestId });

    return c.json({ ok: true });
  });

export default app;
