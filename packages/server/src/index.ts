import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { requireAuth } from "./middleware/require-auth";
import sessions from "./routes/sessions";
import chat from "./routes/chat";
import auth from "./routes/auth";
import billing from "./routes/billing";

const app = new Hono();

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ 
      error: error.message || "Request failed",
    }, error.status);
  };

  // Surface upstream provider errors (e.g. invalid model, rate limit, bad key)
  // as a 502 with the original message so the CLI can show it to the user.
  if (error && typeof error === "object" && "name" in error && error.name === "AI_APICallError") {
    const message = (error as { message?: string }).message;
    console.error("Upstream model error", error);
    return c.json({ error: message ?? "Upstream model request failed" }, 502);
  }

  console.error("Unhandled server error", error);
  // Surfacing the error message to the client makes local debugging much easier.
  // Tighten this to a generic "Internal server error" before deploying publicly.
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : "Internal server error";
  return c.json({ error: message }, 500);
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
// idleTimeout must be high, otherwise LLM tool calls might not complete
export default { port: 3000, fetch: app.fetch, idleTimeout: 255 };
