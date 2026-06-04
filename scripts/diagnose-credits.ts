/**
 * Diagnose why a user's purchased credits don't show up.
 *
 * Reads the SAME Polar config the server uses (POLAR_ACCESS_TOKEN,
 * POLAR_SERVER, POLAR_PRODUCT_ID, POLAR_CREDITS_METER_ID) and prints the live
 * customer state for one external customer id (the user's Clerk user id).
 *
 * Run it with the *production* env (the one the deployed API uses) so it queries
 * the same Polar environment the chat gate does:
 *
 *   POLAR_ACCESS_TOKEN=... POLAR_SERVER=production \
 *   POLAR_PRODUCT_ID=... POLAR_CREDITS_METER_ID=... \
 *   bun run scripts/diagnose-credits.ts user_xxx
 *
 * Find the user's Clerk id (`user_...`) in the Clerk dashboard by email, or in
 * ~/.darkcode/audit.jsonl on their machine.
 */
import { Polar } from "@polar-sh/sdk";

const externalId = process.argv[2];
if (!externalId) {
  console.error("Usage: bun run scripts/diagnose-credits.ts <clerk-user-id>");
  process.exit(1);
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

const accessToken = req("POLAR_ACCESS_TOKEN");
const server = (process.env.POLAR_SERVER ?? "sandbox") as "sandbox" | "production";
const productId = req("POLAR_PRODUCT_ID");
const meterId = req("POLAR_CREDITS_METER_ID");

const polar = new Polar({ accessToken, server });

console.log("─".repeat(60));
console.log(`Polar environment : ${server}`);
console.log(`Configured meter  : ${meterId}`);
console.log(`Configured product: ${productId}`);
console.log(`External id (user): ${externalId}`);
console.log("─".repeat(60));

// 1. Does the meter the server reads even exist on this token/env?
try {
  const meter = await polar.meters.get({ id: meterId });
  console.log(`✓ Meter exists: "${meter.name}" (id ${meter.id})`);
} catch (e) {
  console.log(`✗ Meter ${meterId} NOT found on this token/environment.`);
  console.log("  → POLAR_CREDITS_METER_ID or POLAR_SERVER/POLAR_ACCESS_TOKEN is from the wrong env.");
  console.log("   ", (e as Error).message);
}

// 2. Does the product exist, and does it have a credit benefit attached?
try {
  const product = await polar.products.get({ id: productId });
  console.log(`✓ Product exists: "${product.name}" (id ${product.id})`);
  const benefits = product.benefits ?? [];
  if (benefits.length === 0) {
    console.log("  ✗ Product has NO benefits attached — buying it grants no credits.");
  } else {
    for (const b of benefits) {
      console.log(`  • benefit ${b.id} type=${b.type} "${b.description ?? ""}"`);
    }
    console.log("  → Confirm one is a 'Meter Credit' benefit that credits the meter above.");
  }
} catch (e) {
  console.log(`✗ Product ${productId} NOT found on this token/environment.`);
  console.log("   ", (e as Error).message);
}

// 3. The actual customer state the chat gate reads.
try {
  const state = await polar.customers.getStateExternal({ externalId });
  console.log(`\n✓ Customer exists (external id ${externalId}).`);
  console.log(`  Polar customer id: ${state.id}  email: ${state.email ?? "—"}`);

  if (state.activeMeters.length === 0) {
    console.log("  ✗ Customer has NO active meters — never credited on any meter.");
  }
  for (const m of state.activeMeters) {
    const isTheOne = m.meterId === meterId ? "  ← THIS is the one the server reads" : "";
    console.log(
      `  • meter ${m.meterId}  credited=${m.creditedUnits} consumed=${m.consumedUnits} balance=${m.balance}${isTheOne}`,
    );
  }
  const match = state.activeMeters.find((m) => m.meterId === meterId);
  console.log("\n  RESULT the chat gate sees:");
  console.log(`  balance = ${match?.balance ?? 0}  →  ${(match?.balance ?? 0) > 0 ? "can chat ✓" : "REFUSED (402 no credits) ✗"}`);
} catch (e) {
  const status = (e as { statusCode?: number }).statusCode;
  if (status === 404) {
    console.log(`\n✗ No Polar customer for external id ${externalId} in ${server}.`);
    console.log("  → The purchase landed under a different external id OR a different");
    console.log("    Polar environment (sandbox vs production). This is the #1 cause.");
  } else {
    console.log("\n✗ getStateExternal failed:", (e as Error).message);
  }
}

// 4. Did an order actually land for this customer in THIS environment?
try {
  const orders = await polar.orders.list({ externalCustomerId: externalId, limit: 10 });
  const items = orders.result.items;
  console.log(`\nOrders for this customer in ${server}: ${items.length}`);
  for (const o of items) {
    console.log(`  • ${o.createdAt.toISOString()}  ${o.product?.name ?? "?"}  ${o.totalAmount} ${o.currency} [${o.status ?? "?"}]`);
  }
  if (items.length === 0) {
    console.log("  ✗ No orders here — payment landed in a DIFFERENT Polar environment.");
  }
} catch (e) {
  console.log("\nOrder list failed:", (e as Error).message);
}
