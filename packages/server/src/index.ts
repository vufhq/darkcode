import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { initSentry, captureException } from "./lib/sentry";
import { logger } from "./lib/logger";
import { requestContext, type RequestContextEnv } from "./middleware/request-context";
import { requireAuth } from "./middleware/require-auth";
import sessions from "./routes/sessions";
import chat from "./routes/chat";
import auth from "./routes/auth";
import billing from "./routes/billing";

initSentry();

const isProduction = process.env.NODE_ENV === "production";

const app = new Hono<RequestContextEnv>();

app.use("*", requestContext);

app.onError((error, c) => {
  const requestId = c.get("requestId");
  // userId is only set by requireAuth; may be absent on /auth/* or pre-auth errors.
  const userId = (c.var as { userId?: string }).userId;
  const log = c.get("log") ?? logger;

  if (error instanceof HTTPException) {
    log.warn({ status: error.status, err: error }, "http_exception");
    return c.json(
      { error: error.message || "Request failed", requestId },
      error.status,
    );
  }

  // Surface upstream provider errors (e.g. invalid model, rate limit, bad key)
  // as a 502. In production, return a generic message; in dev, pass the upstream
  // message through to make local debugging easier.
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

app.use("/sessions/*", requireAuth);
app.use("/chat/*", requireAuth);
app.use("/billing/checkout", requireAuth);
app.use("/billing/portal", requireAuth);

const routes = app
  .route("/auth", auth)
  .route("/billing", billing)
  .route("/sessions", sessions)
  .route("/chat", chat);

export type AppType = typeof routes;

const port = Number(process.env.PORT ?? "3000");
logger.info({ port, env: process.env.NODE_ENV ?? "development" }, "server.start");

// idleTimeout must be high, otherwise LLM tool calls might not complete
export default { port, fetch: app.fetch, idleTimeout: 255 };
