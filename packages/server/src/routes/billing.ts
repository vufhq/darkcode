import { Hono } from "hono";
import type { AuthenticatedEnv } from "../middleware/require-auth";
import {
  createCheckoutUrl,
  createCustomerPortalUrl,
  getAvailableCreditsBalance,
  getSubscription,
  listTransactions,
  listUsageEvents,
} from "../lib/polar";
import { logAuditEvent } from "../lib/audit";

const app = new Hono<AuthenticatedEnv>()
  .get("/balance", async (c) => {
    const userId = c.get("userId");
    const credits = await getAvailableCreditsBalance(userId);
    return c.json({ credits, asOf: new Date().toISOString() });
  })
  .get("/usage", async (c) => {
    const userId = c.get("userId");
    const limit = Number(c.req.query("limit") ?? 50);
    const events = await listUsageEvents(userId, Number.isFinite(limit) ? limit : 50);
    return c.json({ events });
  })
  .get("/subscription", async (c) => {
    const userId = c.get("userId");
    const subscription = await getSubscription(userId);
    return c.json(subscription);
  })
  .get("/transactions", async (c) => {
    const userId = c.get("userId");
    const transactions = await listTransactions(userId);
    return c.json({ transactions });
  })
  .post("/checkout", async (c) => {
    const userId = c.get("userId");
    const url = await createCheckoutUrl({ customerExternalId: userId });
    void logAuditEvent({ userId, action: "billing.checkout", requestId: c.get("requestId") });
    return c.json({ url });
  })
  .post("/portal", async (c) => {
    const userId = c.get("userId");
    const url = await createCustomerPortalUrl({ customerExternalId: userId });
    void logAuditEvent({ userId, action: "billing.portal", requestId: c.get("requestId") });
    return c.json({ url });
  })
  .get("/success", (c) => c.text("Done. You can close this tab and return to Darkcode."));

export default app;
