import { createMiddleware } from "hono/factory";
import { authenticateOAuthRequest } from "../lib/auth";
import type { RequestContextEnv } from "./request-context";

export type AuthenticatedEnv = RequestContextEnv & {
  Variables: RequestContextEnv["Variables"] & {
    userId: string;
  };
};

export const requireAuth = createMiddleware<AuthenticatedEnv>(async (c, next) => {
  const log = c.get("log");
  try {
    const auth = await authenticateOAuthRequest(c.req.raw);
    if (!auth) {
      log?.debug("auth.rejected");
      return c.json({ error: "Unauthorized. Run /login to continue." }, 401);
    }

    c.set("userId", auth.userId);
    // Re-bind the request-scoped logger so downstream logs include userId.
    if (log) c.set("log", log.child({ userId: auth.userId }));
    await next();
  } catch (error) {
    log?.warn({ err: error }, "auth.error");
    return c.json({ error: "Unauthorized. Run /login to continue." }, 401);
  }
});
