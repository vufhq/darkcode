import { Hono } from "hono";
import type { AuthenticatedEnv } from "../middleware/require-auth";
import { createCheckoutUrl, createCustomerPortalUrl } from "../lib/polar";
import { logAuditEvent } from "../lib/audit";

const app = new Hono<AuthenticatedEnv>()
  .post("/checkout", async (c) => {
    const userId = c.get("userId");
    const url = await createCheckoutUrl({ customerExternalId: userId, requestUrl: c.req.url });
    void logAuditEvent({ userId, action: "billing.checkout", requestId: c.get("requestId") });
    return c.json({ url });
  })
  .post("/portal", async (c) => {
    const userId = c.get("userId");
    const url = await createCustomerPortalUrl({ customerExternalId: userId, requestUrl: c.req.url });
    void logAuditEvent({ userId, action: "billing.portal", requestId: c.get("requestId") });
    return c.json({ url });
  })
  .get("/success", (c) => c.text("Done. You can close this tab and return to Darkcode."));

export default app;
