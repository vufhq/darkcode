/**
 * Provision the recurring free-tier product + meter-credit benefit (Item 3).
 *
 * Creates, in the target Polar environment:
 *   1. a `meter_credit` benefit ( N credits/cycle, rollover:false ) on the
 *      EXISTING credits meter (POLAR_CREDITS_METER_ID), and
 *   2. a $0 *recurring monthly* product carrying that benefit,
 * then prints the product id to set as `POLAR_FREE_GRANT_PRODUCT_ID`. The server
 * subscribes new users to that product (see `ensureFreeTierGrant`), giving each
 * a refreshing monthly free allowance on the same meter the chat gate reads.
 *
 * Run once per environment. Idempotency: if POLAR_FREE_GRANT_PRODUCT_ID is
 * already set to a product that exists in this env, it refuses (pass --force to
 * create a new one anyway). Created objects also carry a `darkcode_role`
 * metadata marker so duplicates are identifiable in the dashboard.
 *
 * Required token scopes: meters:read, benefits:write, products:read+write.
 *
 *   # sandbox (token from sandbox.polar.sh; .env is production, so override):
 *   POLAR_SERVER=sandbox POLAR_ACCESS_TOKEN=polar_oat_<sandbox> \
 *   POLAR_CREDITS_METER_ID=<sandbox-meter> bun run provision:free-tier
 *
 *   # production (deliberate — note bun auto-loads the production .env):
 *   bun run provision:free-tier --allow-production
 *
 * Env: POLAR_FREE_GRANT_CREDITS (default 75) sets the monthly allowance.
 *      POLAR_ORGANIZATION_ID only needed for a personal (non-org) token.
 */
import { Polar } from "@polar-sh/sdk";

const FREE_TIER_CREDITS = Number(process.env.POLAR_FREE_GRANT_CREDITS ?? 75);
const RECURRING_INTERVAL = "month" as const;
const MARKER = "free_tier_grant"; // metadata.darkcode_role, for findability

const force = process.argv.includes("--force");
const allowProduction = process.argv.includes("--allow-production");

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

if (!Number.isInteger(FREE_TIER_CREDITS) || FREE_TIER_CREDITS <= 0) {
  console.error(`POLAR_FREE_GRANT_CREDITS must be a positive integer (got ${process.env.POLAR_FREE_GRANT_CREDITS}).`);
  process.exit(1);
}

const accessToken = req("POLAR_ACCESS_TOKEN");
const server = (process.env.POLAR_SERVER ?? "sandbox") as "sandbox" | "production";
const meterId = req("POLAR_CREDITS_METER_ID");
const organizationId = process.env.POLAR_ORGANIZATION_ID; // optional (personal tokens only)
const orgField = organizationId ? { organizationId } : {};

if (server === "production" && !allowProduction) {
  console.error("✗ POLAR_SERVER=production. Provisioning prod is deliberate — re-run with");
  console.error("  --allow-production. (Note: bun auto-loads the repo .env, which is production;");
  console.error("  for sandbox pass POLAR_SERVER=sandbox + a sandbox token inline.)");
  process.exit(1);
}

const polar = new Polar({ accessToken, server });

console.log("─".repeat(64));
console.log(`Polar environment : ${server}`);
console.log(`Credits meter     : ${meterId}`);
console.log(`Free allowance    : ${FREE_TIER_CREDITS} credits / ${RECURRING_INTERVAL}`);
console.log("─".repeat(64));

try {
  // Idempotency: if we already have a product id that exists in this env, stop.
  const existingId = process.env.POLAR_FREE_GRANT_PRODUCT_ID;
  if (existingId && !force) {
    try {
      const existing = await polar.products.get({ id: existingId });
      console.log(`\n✓ Already provisioned: POLAR_FREE_GRANT_PRODUCT_ID="${existing.name}" (${existing.id}).`);
      console.log("  Nothing to do. Pass --force to create a new one anyway.");
      process.exit(0);
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
      console.log(`\n• POLAR_FREE_GRANT_PRODUCT_ID=${existingId} not found in ${server} — provisioning fresh.`);
    }
  }

  // The benefit must point at the meter the chat gate reads, so it must exist here.
  const meter = await polar.meters.get({ id: meterId });
  console.log(`\n✓ Meter exists: "${meter.name}"`);

  const benefit = await polar.benefits.create({
    type: "meter_credit",
    // Polar caps the benefit description at 42 chars — keep this template short.
    description: `DarkCode free: ${FREE_TIER_CREDITS} credits/${RECURRING_INTERVAL}`,
    metadata: { darkcode_role: MARKER },
    properties: { units: FREE_TIER_CREDITS, rollover: false, meterId },
    ...orgField,
  });
  console.log(`✓ Created meter_credit benefit: ${benefit.id}`);

  const product = await polar.products.create({
    name: "DarkCode Free Tier",
    recurringInterval: RECURRING_INTERVAL,
    prices: [{ amountType: "free" }],
    metadata: { darkcode_role: MARKER },
    ...orgField,
  });
  await polar.products.updateBenefits({
    id: product.id,
    productBenefitsUpdate: { benefits: [benefit.id] },
  });
  console.log(`✓ Created free product + attached benefit: ${product.id}`);

  console.log("\n" + "═".repeat(64));
  console.log("DONE — set this in the server env for this environment:");
  console.log(`\n  POLAR_FREE_GRANT_PRODUCT_ID=${product.id}\n`);
  console.log("Then new users get the free tier on first authenticated request.");
  console.log("═".repeat(64));
} catch (error) {
  console.error("\n✗ Provisioning failed:", error instanceof Error ? error.message : String(error));
  const status = statusOf(error);
  if (status === 401) {
    console.error(`  → 401: the token isn't valid for POLAR_SERVER=${server}. Sandbox and prod`);
    console.error("    have separate tokens (the repo `.env` token is production). Pass a token");
    console.error("    issued by the matching dashboard inline.");
  } else if (status === 404) {
    console.error(`  → 404: POLAR_CREDITS_METER_ID=${meterId} doesn't exist in ${server} — point`);
    console.error("    it at this environment's credits meter (the `.env` value is production).");
  }
  process.exit(1);
}
