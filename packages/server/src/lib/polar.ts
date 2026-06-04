import { Polar } from "@polar-sh/sdk";
import { env } from "./env";

const polar = new Polar({
  accessToken: env.POLAR_ACCESS_TOKEN,
  server: env.POLAR_SERVER,
});

function hasStatusCode(error: unknown): error is { statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  );
}

// Boot-time sanity check for POLAR_CREDITS_METER_ID. A wrong/stale meter id
// makes `getAvailableCreditsBalance` find no matching active meter and silently
// fall through to `?? 0`, so EVERY hosted turn is refused with "no credits"
// even when the customer has been credited — an invisible, account-wide outage.
// We probe the meter once at startup so a misconfig surfaces as a loud log (and
// a hard crash in production) instead of looking like "everyone is broke".
export type CreditsMeterCheck =
  | { ok: true; name: string }
  | { ok: false; reason: "not_found" | "unreachable"; message: string };

export async function verifyCreditsMeterConfigured(): Promise<CreditsMeterCheck> {
  try {
    const meter = await polar.meters.get({ id: env.POLAR_CREDITS_METER_ID });
    return { ok: true, name: meter.name };
  } catch (error) {
    if (hasStatusCode(error) && error.statusCode === 404) {
      return {
        ok: false,
        reason: "not_found",
        message: `Polar meter ${env.POLAR_CREDITS_METER_ID} does not exist on this token/environment`,
      };
    }
    // Network/transient error — don't conflate "Polar is down right now" with
    // "the meter id is wrong". Caller treats this as a warning, not a crash.
    return {
      ok: false,
      reason: "unreachable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

type CreateCheckoutUrlParams = {
  customerExternalId: string;
};

// Polar redirects users here after checkout / from the customer portal. We
// send them back to the website's Billing page so the `?status=success`
// handler can invalidate the billing queries and show the new balance.
const websiteReturnUrl = new URL(
  "/dashboard/billing?status=success",
  env.WEBSITE_URL,
).toString();

export async function createCheckoutUrl({
  customerExternalId,
}: CreateCheckoutUrlParams) {
  const result = await polar.checkouts.create({
    products: [env.POLAR_PRODUCT_ID],
    successUrl: websiteReturnUrl,
    externalCustomerId: customerExternalId,
    metadata: { source: "darkcode-cli" },
  });

  return result.url;
};

export async function createCustomerPortalUrl({
  customerExternalId,
}: CreateCheckoutUrlParams) {
  const result = await polar.customerSessions.create({
    externalCustomerId: customerExternalId,
    returnUrl: websiteReturnUrl,
  });

  return result.customerPortalUrl;
};

export async function getAvailableCreditsBalance(customerExternalId: string) {
  try {
    const customerState = await polar.customers.getStateExternal({
      externalId: customerExternalId,
    });

    const matchingMeters = customerState.activeMeters.filter(
      (meter) => meter.meterId === env.POLAR_CREDITS_METER_ID,
    );

    if (matchingMeters.length > 1) {
      throw new Error("Expected exactly one matching Polar credits meter");
    }

    const creditsMeter = matchingMeters[0];
    return creditsMeter?.balance ?? 0;
  } catch (error) {
    if (hasStatusCode(error) && error.statusCode === 404) {
      return 0;
    }

    throw error;
  }
};

type IngestAiUsageParams = {
  externalCustomerId: string;
  eventId: string;
  credits: number;
};

export type UsageEventOut = {
  id: string;
  timestamp: string;
  credits: number;
  metadata?: Record<string, unknown>;
};

export async function listUsageEvents(
  externalCustomerId: string,
  limit: number,
): Promise<UsageEventOut[]> {
  const page = await polar.events.list({
    externalCustomerId,
    name: "darkcode_usage",
    limit: Math.max(1, Math.min(100, limit)),
  });
  const items = page.result.items;
  return items.map((event) => {
    const credits = Number((event.metadata as { credits?: unknown }).credits ?? 0);
    return {
      id: event.id,
      timestamp: event.timestamp.toISOString(),
      credits: Number.isFinite(credits) ? credits : 0,
      metadata: event.metadata as Record<string, unknown>,
    };
  });
}

export type SubscriptionOut =
  | { status: "none" }
  | {
      status: "active" | "past_due" | "canceled";
      planName: string;
      renewsAt: string | null;
      cancelAtPeriodEnd?: boolean;
    };

export async function getSubscription(
  externalCustomerId: string,
): Promise<SubscriptionOut> {
  const page = await polar.subscriptions.list({
    externalCustomerId,
    limit: 1,
  });
  const sub = page.result.items[0];
  if (!sub) return { status: "none" };

  // Polar returns its own status enum; collapse it into the three buckets
  // the website's discriminated union expects. Anything we can't classify
  // as active or past_due is surfaced as `canceled`, which still shows the
  // plan name + last-known renewal date.
  const status: "active" | "past_due" | "canceled" =
    sub.status === "active" || sub.status === "trialing"
      ? "active"
      : sub.status === "past_due"
        ? "past_due"
        : "canceled";

  return {
    status,
    planName: sub.product?.name ?? "DarkCode",
    renewsAt:
      status === "canceled" ? null : sub.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

export type TransactionOut = {
  id: string;
  date: string;
  description: string;
  amount: { value: number; currency: string };
};

export async function listTransactions(
  externalCustomerId: string,
): Promise<TransactionOut[]> {
  const page = await polar.orders.list({
    externalCustomerId,
    limit: 50,
  });
  return page.result.items.map((order) => ({
    id: order.id,
    date: order.createdAt.toISOString(),
    description: order.product?.name ?? "DarkCode credits",
    amount: {
      value: order.totalAmount,
      currency: order.currency.toUpperCase(),
    },
  }));
}

export async function ingestAiUsage({
  externalCustomerId,
  eventId,
  credits
}: IngestAiUsageParams) {
  if (credits <= 0) {
    return;
  }

  await polar.events.ingest({
    events: [
      {
        name: "darkcode_usage",
        externalId: eventId,
        externalCustomerId,
        metadata: { credits },
      },
    ],
  });
};
