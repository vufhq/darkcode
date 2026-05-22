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

type CreateCheckoutUrlParams = {
  customerExternalId: string;
  requestUrl: string;
};

export async function createCheckoutUrl({
  customerExternalId,
  requestUrl,
}: CreateCheckoutUrlParams) {
  const result = await polar.checkouts.create({
    products: [env.POLAR_PRODUCT_ID],
    successUrl: new URL("/billing/success", requestUrl).toString(),
    externalCustomerId: customerExternalId,
    metadata: { source: "darkcode-cli" },
  });

  return result.url;
};

export async function createCustomerPortalUrl({
  customerExternalId,
  requestUrl,
}: CreateCheckoutUrlParams) {
  const result = await polar.customerSessions.create({
    externalCustomerId: customerExternalId,
    returnUrl: new URL("/billing/success", requestUrl).toString(),
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
