import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";

import { env, isProduction } from "./lib/env";
import { initSentry, captureException, Sentry } from "./lib/sentry";
import { logger } from "./lib/logger";
import { startPolarOutboxSweeper, stopPolarOutboxSweeper } from "./lib/polar-outbox";
import { closeRedis } from "./lib/redis";
import { db } from "@darkcode/database/client";
import { requestContext, type RequestContextEnv } from "./middleware/request-context";
import { rateLimit, userIdOrIp } from "./middleware/rate-limit";
import { requireAuth } from "./middleware/require-auth";
import sessions from "./routes/sessions";
import chat from "./routes/chat";
import auth from "./routes/auth";
import billing from "./routes/billing";
import health from "./routes/health";

initSentry();
startPolarOutboxSweeper();

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

app.use(
  "/auth/*",
  rateLimit({ bucket: "auth", limit: 30, windowMs: 60_000 }),
);

app.use("/sessions/*", requireAuth);
app.use("/chat/*", requireAuth);
app.use("/billing/checkout", requireAuth);
app.use("/billing/portal", requireAuth);
app.use("/billing/balance", requireAuth);
app.use("/billing/usage", requireAuth);
app.use("/billing/subscription", requireAuth);
app.use("/billing/transactions", requireAuth);

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
  .route("/", health)
  .route("/auth", auth)
  .route("/billing", billing)
  .route("/sessions", sessions)
  .route("/chat", chat);

export type AppType = typeof routes;

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
  // idleTimeout must be high, otherwise LLM tool calls might not complete
  idleTimeout: 255,
});

logger.info(
  {
    port: env.PORT,
    env: env.NODE_ENV,
    redis: env.REDIS_URL ? "configured" : "memory-fallback",
    cors: corsAllowAll ? "*" : corsOrigins,
  },
  "server.start",
);

// Loud, deliberate warnings for production misconfiguration that won't
// crash the process but will hurt in real ways:
//   - No Redis → rate limits and idempotency keys are per-instance only.
//     A multi-replica deploy effectively has no protection.
//   - CORS '*' → any origin can hit authenticated endpoints (with credentials
//     disabled this is less bad, but still surprising in prod).
//   - No Sentry → unhandled errors disappear into pino logs only.
if (isProduction) {
  if (!env.REDIS_URL) {
    logger.warn("production.redis_missing — rate limits + idempotency are single-instance only");
  }
  if (corsAllowAll) {
    logger.warn("production.cors_wildcard — CORS_ORIGINS=* in production; lock this down");
  }
  if (!env.SENTRY_DSN) {
    logger.warn("production.sentry_missing — unhandled errors will not be captured");
  }
}

// ---------- graceful shutdown ----------
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? "30000");
let shuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, timeoutMs: SHUTDOWN_TIMEOUT_MS }, "shutdown.initiated");

  // 1. Stop accepting new connections; let in-flight ones drain naturally.
  server.stop(false);

  // 2. Hard timeout — if streams are stuck, force-exit so the orchestrator
  // can replace us rather than hang past the platform's grace period.
  const forceExit = setTimeout(() => {
    logger.error("shutdown.timeout_exceeded.force_exiting");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  // 3. Stop background workers.
  stopPolarOutboxSweeper();

  // 4. Flush Sentry events before we exit so nothing in-flight gets lost.
  try {
    await Sentry.close(2000);
  } catch (error) {
    logger.warn({ err: error }, "shutdown.sentry_close_failed");
  }

  // 5. Close external resources.
  try {
    await closeRedis();
  } catch (error) {
    logger.warn({ err: error }, "shutdown.redis_close_failed");
  }
  try {
    await db.$disconnect();
  } catch (error) {
    logger.warn({ err: error }, "shutdown.db_disconnect_failed");
  }

  logger.info("shutdown.complete");
  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

export default server;
