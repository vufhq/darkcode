import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";

import { env, isProduction } from "./lib/env";
import { initSentry, captureException } from "./lib/sentry";
import { logger } from "./lib/logger";
import { requestContext, type RequestContextEnv } from "./middleware/request-context";
import { rateLimit, userIdOrIp } from "./middleware/rate-limit";
import { requireAuth } from "./middleware/require-auth";
import sessions from "./routes/sessions";
import chat from "./routes/chat";
import auth from "./routes/auth";
import billing from "./routes/billing";

initSentry();

const corsOrigins = env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
const corsAllowAll = corsOrigins.length === 1 && corsOrigins[0] === "*";

const app = new Hono<RequestContextEnv>();

app.use("*", requestContext);

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin;
      if (corsAllowAll) return origin;
      return corsOrigins.includes(origin) ? origin : null;
    },
    credentials: !corsAllowAll,
  }),
);

// Body-size caps. Chat allows larger bodies because conversation history can grow.
const standardBodyLimit = bodyLimit({ maxSize: 100 * 1024 });
const chatBodyLimit = bodyLimit({ maxSize: 2 * 1024 * 1024 });

app.onError((error, c) => {
  const requestId = c.get("requestId");
  const userId = (c.var as { userId?: string }).userId;
  const log = c.get("log") ?? logger;

  if (error instanceof HTTPException) {
    log.warn({ status: error.status, err: error }, "http_exception");
    return c.json(
      { error: error.message || "Request failed", requestId },
      error.status,
    );
  }

  if (error && typeof error === "object" && "name" in error && error.name === "AI_APICallError") {
    log.error({ err: error }, "upstream_model_error");
    captureException(error, { userId, requestId, tags: { kind: "upstream_model" } });
    const message = isProduction
      ? "Upstream model request failed"
      : (error as { message?: string }).message ?? "Upstream model request failed";
    return c.json({ error: message, requestId }, 502);
  }

  log.error({ err: error }, "unhandled_server_error");
  captureException(error, { userId, requestId });
  const message = isProduction
    ? "Internal server error"
    : error instanceof Error
      ? `${error.name}: ${error.message}`
      : "Internal server error";
  return c.json({ error: message, requestId }, 500);
});

// Per-IP limit on the OAuth callback to slow down brute-force code/state probing.
app.use(
  "/auth/*",
  rateLimit({ bucket: "auth", limit: 30, windowMs: 60_000 }),
);

app.use("/sessions/*", requireAuth);
app.use("/chat/*", requireAuth);
app.use("/billing/checkout", requireAuth);
app.use("/billing/portal", requireAuth);

// Authenticated rate limits.
app.use(
  "/sessions/*",
  standardBodyLimit,
  rateLimit({ bucket: "sessions", limit: 120, windowMs: 60_000, keyResolver: userIdOrIp }),
);
app.use(
  "/chat/*",
  chatBodyLimit,
  rateLimit({ bucket: "chat", limit: 30, windowMs: 60_000, keyResolver: userIdOrIp }),
);
app.use(
  "/billing/*",
  standardBodyLimit,
  rateLimit({ bucket: "billing", limit: 20, windowMs: 60_000, keyResolver: userIdOrIp }),
);

const routes = app
  .route("/auth", auth)
  .route("/billing", billing)
  .route("/sessions", sessions)
  .route("/chat", chat);

export type AppType = typeof routes;

logger.info(
  {
    port: env.PORT,
    env: env.NODE_ENV,
    redis: env.REDIS_URL ? "configured" : "memory-fallback",
    cors: corsAllowAll ? "*" : corsOrigins,
  },
  "server.start",
);

// idleTimeout must be high, otherwise LLM tool calls might not complete
export default { port: env.PORT, fetch: app.fetch, idleTimeout: 255 };
