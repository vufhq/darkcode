import { Hono } from "hono";
import type { AuthenticatedEnv } from "../middleware/require-auth";
import {
  createCheckoutUrl,
  createCustomerPortalUrl,
  ensureFreeTierGrant,
  getAvailableCreditsBalance,
  getSubscription,
  listTransactions,
  listUsageEvents,
} from "../lib/polar";
import { logAuditEvent } from "../lib/audit";
import { claimIdempotencyKey } from "../lib/idempotency";
import { getUserPrimaryEmail } from "../lib/auth";
import { logger } from "../lib/logger";
import { env } from "../lib/env";
import { clientIp } from "../middleware/rate-limit";
import { freeGrantIpLimitReached, recordFreeGrantForIp } from "../lib/free-grant-guard";

const app = new Hono<AuthenticatedEnv>()
  .get("/balance", async (c) => {
    const userId = c.get("userId");
    // Lazily grant the free recurring credit tier the first time we see an
    // authenticated user (there is no Clerk signup webhook). Fire-and-forget so
    // it never blocks or fails the balance read; throttled by an idempotency
    // claim, independently idempotent in Polar, and rate-capped per source IP.
    void maybeGrantFreeTier(userId, clientIp(c), c.get("requestId"));
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
  .post("/checkout/pro", async (c) => {
    const userId = c.get("userId");
    // Pro is a paid recurring product and must go through Polar checkout. When
    // it isn't provisioned for this environment there's nothing to subscribe to
    // — say so explicitly rather than 500'ing on a missing product id.
    if (!env.POLAR_PRO_PRODUCT_ID) {
      return c.json(
        { error: "Pro isn't available right now.", code: "pro_unavailable" },
        503,
      );
    }
    const url = await createCheckoutUrl({
      customerExternalId: userId,
      productId: env.POLAR_PRO_PRODUCT_ID,
    });
    void logAuditEvent({ userId, action: "billing.checkout_pro", requestId: c.get("requestId") });
    return c.json({ url });
  })
  .post("/portal", async (c) => {
    const userId = c.get("userId");
    const url = await createCustomerPortalUrl({ customerExternalId: userId });
    void logAuditEvent({ userId, action: "billing.portal", requestId: c.get("requestId") });
    return c.json({ url });
  })
  .get("/success", (c) => c.text("Done. You can close this tab and return to Darkcode."));

// Best-effort, fire-and-forget free-tier grant. The idempotency claim ensures
// at most one attempt per TTL window per user (so we don't call Polar on every
// balance poll); `ensureFreeTierGrant` is also idempotent against Polar, and a
// no-op when POLAR_FREE_GRANT_PRODUCT_ID is unset. Never throws to the caller.
async function maybeGrantFreeTier(
  userId: string,
  ip: string,
  requestId: string | undefined,
): Promise<void> {
  try {
    // Disabled until provisioned: bail before any claim or Clerk call so the
    // feature is a true no-op when POLAR_FREE_GRANT_PRODUCT_ID is unset.
    if (!env.POLAR_FREE_GRANT_PRODUCT_ID) return;
    if (!(await claimIdempotencyKey("free-tier-grant", userId, "v1"))) return;
    // Per-IP velocity guard (Tier 3 abuse): blunt scripted multi-signup farming.
    // Checked AFTER the per-user claim (so it isn't hit on every balance poll)
    // and BEFORE issuing the grant. Returning users resolve to "already_granted"
    // below and never call recordFreeGrantForIp, so a shared NAT/CGNAT IP isn't
    // penalised for legitimate repeat traffic. Fails open.
    if (await freeGrantIpLimitReached(ip)) {
      logger.warn({ userId, ip }, "free_tier.ip_velocity_blocked");
      void logAuditEvent({ userId, action: "billing.free_tier_blocked", requestId });
      return;
    }
    const email = await getUserPrimaryEmail(userId);
    if (!email) {
      logger.warn({ userId }, "free_tier.skip_no_email");
      return;
    }
    const result = await ensureFreeTierGrant({ externalCustomerId: userId, email });
    if (result === "granted") {
      // Count only grants that actually landed, so the per-IP window tracks real
      // new identities rather than every poll.
      await recordFreeGrantForIp(ip);
      logger.info({ userId }, "free_tier.granted");
      void logAuditEvent({ userId, action: "billing.free_tier_granted", requestId });
    }
  } catch (error) {
    logger.warn({ err: error, userId }, "free_tier.grant_failed");
  }
}

export default app;
