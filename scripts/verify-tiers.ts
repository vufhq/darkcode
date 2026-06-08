/**
 * Tier verifier — answers the two launch-blocking open questions in
 * MONETIZATION.md "Left before launch" for Items 3 & 4, against a live SANDBOX:
 *
 *   (A/B) SHARED-METER NETTING — free + Pro + pay-as-you-go credits all sit on
 *         the SAME meter (POLAR_CREDITS_METER_ID). Do multiple active
 *         meter_credit grants STACK additively on `creditedUnits`, and do our
 *         `darkcode_usage` debits net against the combined pool? (Fully
 *         verifiable in one run — this is the script's main job.)
 *
 *   (C)   rollover:false PER-CYCLE REFRESH — does a `rollover:false` benefit
 *         reset the allowance each billing cycle rather than stacking? This is
 *         inherently TIME-GATED (a renewal must elapse), so the script can only
 *         SET IT UP and give you a read-only re-check mode; it cannot
 *         fast-forward Polar's clock. See the verdict for what to look for.
 *
 * The grant primitive is a `meter_credit` benefit on the credits meter; granting
 * it raises `creditedUnits`, and balance = creditedUnits − consumedUnits (the
 * exact number `getAvailableCreditsBalance` reads). We model the three credit
 * sources as three active grants on one customer:
 *   - free  (default 75)   — recurring free product (Item 3)
 *   - pro   (default 900)  — recurring product (Item 4; priced free here, since
 *                            the netting question is price-independent)
 *   - payg  (default 100)  — stands in for a persistent top-up order
 *
 * It is self-contained: creates a throwaway meter (unless POLAR_CREDITS_METER_ID
 * is set), customer, benefits, products + subscriptions, watches the meter
 * across each grant and a debit, prints a verdict, then cleans up (--keep to
 * inspect in the dashboard).
 *
 * Required token scopes: meters:read+write, benefits:write, products:write,
 * customers:read+write, subscriptions:write, events:write.
 *
 * Run against SANDBOX (creates real objects + credits/debits a meter). The token
 * MUST be issued by sandbox.polar.sh — sandbox and production are separate
 * systems with separate tokens, and bun auto-loads the repo `.env` (PRODUCTION),
 * so override inline:
 *
 *   POLAR_ACCESS_TOKEN=polar_oat_<sandbox> POLAR_SERVER=sandbox \
 *   bun run verify:tiers
 *
 * Re-check the rollover refresh after a cycle elapses (no setup, read-only):
 *
 *   POLAR_ACCESS_TOKEN=polar_oat_<sandbox> POLAR_SERVER=sandbox \
 *   POLAR_CREDITS_METER_ID=<same-meter> bun run verify:tiers --check <externalId>
 *
 * Personal (non-org) token? also set POLAR_ORGANIZATION_ID=...
 *
 * Env knobs:  VERIFY_FREE_UNITS (75)  VERIFY_PRO_UNITS (900)
 *             VERIFY_PAYG_UNITS (100) VERIFY_DEBIT_UNITS (50)
 *             VERIFY_INTERVAL (month — use a shorter interval if your org allows,
 *                              to make the Part C re-check land sooner)
 * Flags:  --keep              leave throwaway objects (skip cleanup)
 *         --check <extId>     read-only: print the meter state for a customer
 *         --allow-production  required to run when POLAR_SERVER=production
 */
import { Polar } from "@polar-sh/sdk";

const FREE_UNITS = Number(process.env.VERIFY_FREE_UNITS ?? 75);
const PRO_UNITS = Number(process.env.VERIFY_PRO_UNITS ?? 900);
const PAYG_UNITS = Number(process.env.VERIFY_PAYG_UNITS ?? 100);
const DEBIT_UNITS = Number(process.env.VERIFY_DEBIT_UNITS ?? 50);
const INTERVAL = (process.env.VERIFY_INTERVAL ?? "month") as "month" | "year";

const SUM = FREE_UNITS + PRO_UNITS + PAYG_UNITS;
const POLL_ATTEMPTS = 14;
const POLL_DELAY_MS = 1500;

const keep = process.argv.includes("--keep");
const allowProduction = process.argv.includes("--allow-production");
const checkFlagIndex = process.argv.indexOf("--check");
const checkExternalId =
  checkFlagIndex !== -1 ? process.argv[checkFlagIndex + 1] : undefined;

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

const accessToken = req("POLAR_ACCESS_TOKEN");
const server = (process.env.POLAR_SERVER ?? "sandbox") as "sandbox" | "production";
let meterId = process.env.POLAR_CREDITS_METER_ID;
const organizationId = process.env.POLAR_ORGANIZATION_ID;
const orgField = organizationId ? { organizationId } : {};

if (server === "production" && !allowProduction) {
  console.error("✗ Refusing to run against PRODUCTION — this creates throwaway");
  console.error("  products/benefits/customer and credits+debits the meter.");
  console.error("  Use POLAR_SERVER=sandbox, or pass --allow-production if you mean it.");
  process.exit(1);
}

const polar = new Polar({ accessToken, server });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type MeterReading = { credited: number; consumed: number; balance: number } | null;

async function readMeter(externalId: string): Promise<MeterReading> {
  const state = await polar.customers.getStateExternal({ externalId });
  const m = state.activeMeters.find((x) => x.meterId === meterId);
  if (!m) return null;
  return { credited: m.creditedUnits, consumed: m.consumedUnits, balance: m.balance };
}

function fmt(r: MeterReading): string {
  return r
    ? `credited=${r.credited} consumed=${r.consumed} balance=${r.balance}`
    : "(no active meter for this customer)";
}

// Poll until `predicate(reading)` holds (or the window elapses). Returns the
// last reading either way.
async function pollMeter(
  externalId: string,
  label: string,
  predicate: (r: MeterReading) => boolean,
): Promise<MeterReading> {
  let last: MeterReading = null;
  for (let i = 1; i <= POLL_ATTEMPTS; i++) {
    last = await readMeter(externalId);
    console.log(`   [${label}] ${i}/${POLL_ATTEMPTS}: ${fmt(last)}`);
    if (predicate(last)) return last;
    if (i < POLL_ATTEMPTS) await sleep(POLL_DELAY_MS);
  }
  return last;
}

// ── --check mode: read-only re-check (for the time-gated Part C) ────────────
if (checkExternalId) {
  if (!meterId) {
    console.error("✗ --check needs POLAR_CREDITS_METER_ID set to the meter the customer was credited on.");
    process.exit(1);
  }
  try {
    await polar.meters.get({ id: meterId });
    const r = await readMeter(checkExternalId);
    console.log("─".repeat(64));
    console.log(`Re-check (${server}) customer=${checkExternalId}`);
    console.log(`Meter ${meterId}: ${fmt(r)}`);
    console.log("─".repeat(64));
    console.log("rollover:false expectation across a renewal:");
    console.log(`  • the allotment should RESET, not stack — creditedUnits should not`);
    console.log(`    have grown by another full allowance beyond what was consumed.`);
    console.log(`  • i.e. available balance returns to ~the allotment at cycle start,`);
    console.log(`    unused credits from the prior cycle are dropped.`);
    process.exit(0);
  } catch (error) {
    console.error("✗ --check failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const stamp = Date.now();
const externalId = `darkcode-tier-verify-${stamp}`;
const email = process.env.POLAR_SPIKE_EMAIL ?? `darkcode-tier-verify-${stamp}@gmail.com`;

const createdBenefitIds: string[] = [];
const createdProductIds: string[] = [];
let meterCreated = false;
let customerCreated = false;
let runError: unknown;

console.log("─".repeat(64));
console.log(`Polar environment : ${server}`);
console.log(`Credits meter     : ${meterId ?? "(auto-create throwaway)"}`);
console.log(`Throwaway customer: ${externalId}`);
console.log(`Grants            : free=${FREE_UNITS} pro=${PRO_UNITS} payg=${PAYG_UNITS} (sum=${SUM})`);
console.log(`Debit             : ${DEBIT_UNITS} (expect balance ${SUM} → ${SUM - DEBIT_UNITS})`);
console.log(`Recurring interval: ${INTERVAL}`);
console.log("─".repeat(64));

// Grant one meter_credit benefit via its own recurring product + subscription,
// then poll until the cumulative target lands. Returns nothing; throws on error.
async function grant(label: string, units: number, cumulativeTarget: number): Promise<MeterReading> {
  const benefit = await polar.benefits.create({
    type: "meter_credit",
    description: `[verify ${stamp}] ${label} ${units}`,
    properties: { units, rollover: false, meterId: meterId! },
    ...orgField,
  });
  createdBenefitIds.push(benefit.id);

  const product = await polar.products.create({
    name: `[verify ${stamp}] ${label}`,
    recurringInterval: INTERVAL,
    prices: [{ amountType: "free" }],
    ...orgField,
  });
  createdProductIds.push(product.id);
  await polar.products.updateBenefits({
    id: product.id,
    productBenefitsUpdate: { benefits: [benefit.id] },
  });

  const sub = await polar.subscriptions.create({ productId: product.id, externalCustomerId: externalId });
  console.log(`\n✓ ${label}: benefit ${benefit.id} → product ${product.id} → sub ${sub.id} (${sub.status})`);
  console.log(`  Polling for cumulative credited ≥ ${cumulativeTarget}...`);
  return pollMeter(externalId, label, (r) => (r?.credited ?? 0) >= cumulativeTarget);
}

let afterFree: MeterReading = null;
let afterPro: MeterReading = null;
let afterPayg: MeterReading = null;
let afterDebit: MeterReading = null;

try {
  // 0. Resolve the meter (reuse real sandbox meter, or create a throwaway with
  //    the production filter/aggregation so darkcode_usage debits register).
  if (meterId) {
    try {
      const meter = await polar.meters.get({ id: meterId });
      console.log(`\n✓ Reusing meter: "${meter.name}" (${meterId})`);
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
      console.log(`\n• Meter ${meterId} not found in ${server} — creating a throwaway.`);
      meterId = undefined;
    }
  }
  if (!meterId) {
    const meter = await polar.meters.create({
      name: `[verify ${stamp}] throwaway credits meter`,
      filter: {
        conjunction: "and",
        clauses: [{ property: "name", operator: "eq", value: "darkcode_usage" }],
      },
      aggregation: { func: "sum", property: "credits" },
      ...orgField,
    });
    meterId = meter.id;
    meterCreated = true;
    console.log(`✓ Created throwaway meter: ${meter.id}`);
  }

  // 1. Customer must exist before we can subscribe / ingest by external id.
  await polar.customers.create({ email, externalId, ...orgField });
  customerCreated = true;
  console.log(`✓ Created customer (externalId=${externalId})`);

  const before = await readMeter(externalId);
  console.log(`\n• BEFORE any grant: ${fmt(before)}`);

  // 2. Part A — three active grants on one meter; expect ADDITIVE stacking.
  afterFree = await grant("free", FREE_UNITS, FREE_UNITS);
  afterPro = await grant("pro", PRO_UNITS, FREE_UNITS + PRO_UNITS);
  afterPayg = await grant("payg", PAYG_UNITS, SUM);

  // 3. Part B — a darkcode_usage debit must net against the COMBINED pool.
  if ((afterPayg?.credited ?? 0) >= SUM) {
    await polar.events.ingest({
      events: [
        {
          name: "darkcode_usage",
          externalId: `verify-debit-${stamp}`,
          externalCustomerId: externalId,
          metadata: { credits: DEBIT_UNITS },
        },
      ],
    });
    console.log(`\n✓ Ingested darkcode_usage debit of ${DEBIT_UNITS}. Polling for it to land...`);
    afterDebit = await pollMeter(externalId, "after-debit", (r) => (r?.consumed ?? 0) >= DEBIT_UNITS);
  } else {
    console.log("\n⚠ Grants did not all land within the poll window — skipping the debit step.");
  }
} catch (error) {
  runError = error;
  const status = statusOf(error);
  console.error("\n✗ Verify failed:", error instanceof Error ? error.message : String(error));
  if (status === 401) {
    console.error(`  → 401: token isn't valid for POLAR_SERVER=${server}. Sandbox and prod`);
    console.error("    use SEPARATE tokens; the repo `.env` token is production.");
  } else if (status === 404) {
    console.error(`  → 404: a resource (likely the meter id) doesn't exist in ${server}.`);
    console.error("    Unset POLAR_CREDITS_METER_ID to auto-create a throwaway meter.");
  }
  process.exitCode = 1;
} finally {
  if (keep) {
    console.log("\n(--keep) Leaving throwaway objects:");
    console.log(`  customer=${externalId}`);
    console.log(`  benefits=${createdBenefitIds.join(",") || "—"}`);
    console.log(`  products=${createdProductIds.join(",") || "—"}`);
    if (meterCreated) console.log(`  meter=${meterId}`);
    console.log(`\n  To re-check the rollover refresh after a renewal cycle:`);
    console.log(`  POLAR_SERVER=${server} POLAR_CREDITS_METER_ID=${meterId} \\`);
    console.log(`    bun run verify:tiers --check ${externalId}`);
  } else {
    console.log("\nCleaning up throwaway objects...");
    if (customerCreated) {
      try {
        await polar.customers.deleteExternal({ externalId });
        console.log("  ✓ deleted customer (cancels its subscriptions + revokes grants)");
      } catch (e) {
        console.log("  • customer cleanup skipped:", (e as Error).message);
      }
    }
    for (const id of createdBenefitIds) {
      try {
        await polar.benefits.delete({ id });
        console.log(`  ✓ deleted benefit ${id}`);
      } catch (e) {
        console.log(`  • benefit ${id} cleanup skipped:`, (e as Error).message);
      }
    }
    for (const id of createdProductIds) {
      console.log(`  • product ${id} left in place (no delete API; archive in dashboard if desired)`);
    }
    if (meterCreated) console.log(`  • meter ${meterId} left in place (meters have no delete API)`);
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(64));
console.log("VERDICT");
console.log("═".repeat(64));

const stacked = afterPayg?.credited === SUM;
const debitNetted = afterDebit?.balance === SUM - DEBIT_UNITS && afterDebit?.consumed === DEBIT_UNITS;

if (runError !== undefined) {
  console.log("✗ ERRORED — aborted before a conclusion (see the error above). Nothing proven.");
} else {
  console.log("\n[A/B] Shared-meter netting (free + Pro + PAYG on one meter):");
  if (!stacked) {
    console.log(`  ✗ Grants did NOT stack additively — expected credited=${SUM}, got ${afterPayg?.credited ?? "?"}.`);
    console.log(`    free=${fmt(afterFree)} | +pro=${fmt(afterPro)} | +payg=${fmt(afterPayg)}`);
    console.log("    → Free + Pro + PAYG can't safely share one meter as-is. Consider separate");
    console.log("      meters per source, or revisit the credit model before launch.");
  } else if (!debitNetted) {
    console.log(`  ⚠ Grants stacked to ${SUM}, but the debit didn't net cleanly`);
    console.log(`    (expected balance ${SUM - DEBIT_UNITS}, got ${afterDebit?.balance ?? "?"}). Re-run; if it`);
    console.log("    persists, the meter filter/aggregation may not match darkcode_usage.");
  } else {
    console.log(`  ✓ Grants STACK additively (credited=${SUM}) and a darkcode_usage debit nets`);
    console.log(`    against the combined pool (balance ${SUM} → ${afterDebit?.balance}). Free + Pro +`);
    console.log("    PAYG can share the prod meter — the gauge/gate read the summed balance with");
    console.log("    no code change. (Caveat: a revoke/cancel claws back THAT grant's units only —");
    console.log("    persistent PAYG order credits are unaffected; see grant-mechanism-spike.)");
  }

  console.log("\n[C] rollover:false per-cycle refresh — TIME-GATED, not provable in one run:");
  console.log(`  • Setup is complete on customer ${externalId} (interval=${INTERVAL}).`);
  console.log("  • Let a renewal cycle elapse (or use a shorter VERIFY_INTERVAL if your org");
  console.log("    allows), then re-check read-only:");
  console.log(`      POLAR_SERVER=${server} POLAR_CREDITS_METER_ID=${meterId} \\`);
  console.log(`        bun run verify:tiers --check ${externalId}`);
  console.log("  • PASS if the allowance RESETS each cycle (creditedUnits doesn't grow by another");
  console.log("    full allotment on top of unused credits) — i.e. use-it-or-lose-it, not stacking.");
  if (!keep) {
    console.log("  ⚠ This run CLEANED UP the customer, so the --check above won't find it.");
    console.log("    Re-run with --keep to leave the subscriptions alive for the cycle re-check.");
  }
}
console.log("═".repeat(64));
