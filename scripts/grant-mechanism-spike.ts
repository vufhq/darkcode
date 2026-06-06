/**
 * Polar grant-mechanism spike — verify the ONE open question from the
 * MONETIZATION.md "Spike done" section:
 *
 *   Does `subscriptions.revoke` claw back already-credited meter units?
 *
 * The grant primitive is a **Meter Credit benefit** on the EXISTING credits
 * meter. Granting it raises `creditedUnits`; balance = credited − consumed
 * (the same number `getAvailableCreditsBalance` reads). `subscriptions.create`
 * only accepts a *recurring* free product, so a free grant would re-credit
 * every cycle — the plan is to `revoke` immediately after to make it one-time.
 * That only works if revoke does NOT subtract the units it already granted.
 * Types can't answer that; this script does, against a live SANDBOX org.
 *
 * It is fully self-contained: it creates a throwaway benefit + free product +
 * customer + subscription, watches the meter balance across grant → revoke,
 * prints a verdict, then cleans the throwaways up (pass --keep to inspect them
 * in the Polar dashboard instead).
 *
 * Required token scopes: meters:read+write, benefits:write, products:write,
 * customers:read+write, subscriptions:write.
 *
 * Run against SANDBOX (it creates real objects + credits a meter). The token
 * MUST be issued by the SANDBOX dashboard (sandbox.polar.sh) — Polar sandbox and
 * production are separate systems with separate tokens:
 *
 *   POLAR_ACCESS_TOKEN=polar_oat_<sandbox> POLAR_SERVER=sandbox \
 *   bun run scripts/grant-mechanism-spike.ts
 *
 * POLAR_CREDITS_METER_ID is OPTIONAL: set it to reuse your real sandbox credits
 * meter (full fidelity); omit it and the script creates a throwaway meter (the
 * claw-back question is meter-agnostic).
 *
 * NOTE: bun auto-loads the repo `.env`, which here holds the PRODUCTION Polar
 * config — so the inline `POLAR_SERVER=sandbox` + a sandbox `POLAR_ACCESS_TOKEN`
 * above are REQUIRED to override it; inline env vars win over `.env`. The
 * production guard refuses to run otherwise, so you can't credit prod by accident.
 *
 * If your token is a *personal* (non-org) token, also set
 * POLAR_ORGANIZATION_ID=...  (org tokens imply the org and don't need it.)
 *
 * Flags:  --keep              leave the throwaway objects (skip cleanup)
 *         --allow-production  required to run when POLAR_SERVER=production
 */
import { Polar } from "@polar-sh/sdk";

const GRANT_UNITS = 200; // mirrors the planned $2 / 200-credit free grant
const POLL_ATTEMPTS = 12;
const POLL_DELAY_MS = 1500;

const keep = process.argv.includes("--keep");
const allowProduction = process.argv.includes("--allow-production");

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
// Optional: reuse your real sandbox credits meter for full fidelity. If unset,
// the script creates a throwaway meter — the revoke/claw-back question is
// meter-agnostic (credits are granted as units, independent of aggregation).
let meterId = process.env.POLAR_CREDITS_METER_ID;
const organizationId = process.env.POLAR_ORGANIZATION_ID; // optional (needed only for personal tokens)
const orgField = organizationId ? { organizationId } : {};

if (server === "production" && !allowProduction) {
  console.error("✗ Refusing to run against PRODUCTION — this creates a throwaway");
  console.error("  product/benefit/customer and credits the production meter.");
  console.error("  Use POLAR_SERVER=sandbox, or pass --allow-production if you really mean it.");
  process.exit(1);
}

const polar = new Polar({ accessToken, server });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A brand-new external id + email each run so re-runs never collide on Polar's
// "must be unique within the organization" constraint.
const stamp = Date.now();
const externalId = `darkcode-grant-spike-${stamp}`;
// Polar validates emails with the `email-validator` lib, which rejects reserved
// TLDs (.invalid/.test/.example and example.com). Use a real public domain — no
// mail is ever sent (customer create + the free subscription send nothing, and we
// delete the customer in cleanup). Override with POLAR_SPIKE_EMAIL if you prefer.
const email = process.env.POLAR_SPIKE_EMAIL ?? `darkcode-grant-spike-${stamp}@gmail.com`;

type MeterReading = { credited: number; consumed: number; balance: number } | null;

// The exact value the chat gate reads: the customer's active meter that matches
// the resolved credits meter id. Returns null when the customer has no active
// entry for it (e.g. before any grant, or if revoke removes the active meter).
async function readMeter(): Promise<MeterReading> {
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

// Poll the meter. `expectBalance` short-circuits as soon as it's reached (used
// for the grant phase, where we know the target). Omit it to watch the full
// window (used for the revoke phase, where we're looking for a *drop*).
async function pollMeter(
  label: string,
  expectBalance?: number,
): Promise<MeterReading> {
  let last: MeterReading = null;
  for (let i = 1; i <= POLL_ATTEMPTS; i++) {
    last = await readMeter();
    console.log(`   [${label}] ${i}/${POLL_ATTEMPTS}: ${fmt(last)}`);
    if (expectBalance !== undefined && last?.balance === expectBalance) return last;
    if (i < POLL_ATTEMPTS) await sleep(POLL_DELAY_MS);
  }
  return last;
}

let benefitId: string | undefined;
let productId: string | undefined;
let meterCreated = false;
let customerCreated = false;
let runError: unknown;

console.log("─".repeat(64));
console.log(`Polar environment : ${server}`);
console.log(`Credits meter     : ${meterId ?? "(auto-create throwaway)"}`);
console.log(`Throwaway customer: ${externalId}`);
console.log(`Grant size        : ${GRANT_UNITS} units`);
console.log("─".repeat(64));

let afterSub: MeterReading = null;
let afterRevoke: MeterReading = null;

try {
  // 0. Resolve the meter. Reuse the provided one if it exists in this env;
  //    otherwise (unset, or a 404 — e.g. the .env *production* meter id while
  //    running on sandbox) create a throwaway, so a sandbox token alone suffices.
  //    A non-404 error (e.g. 401 auth) propagates — that must be fixed, not masked.
  if (meterId) {
    try {
      const meter = await polar.meters.get({ id: meterId });
      console.log(`\n✓ Reusing meter: "${meter.name}" (${meterId})`);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      console.log(`\n• Meter ${meterId} not found in ${server} — creating a throwaway instead.`);
      meterId = undefined;
    }
  }
  if (!meterId) {
    const meter = await polar.meters.create({
      name: `[spike ${stamp}] throwaway credits meter`,
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

  // 1. The grant primitive: a meter_credit benefit pointed at the credits meter.
  const benefit = await polar.benefits.create({
    type: "meter_credit",
    description: `[spike ${stamp}] ${GRANT_UNITS}-unit grant test`,
    properties: { units: GRANT_UNITS, rollover: false, meterId },
    ...orgField,
  });
  benefitId = benefit.id;
  console.log(`✓ Created meter_credit benefit: ${benefit.id}`);

  // 2. A free *recurring* product (subscriptions.create only accepts free
  //    recurring products) and attach the benefit to it.
  const product = await polar.products.create({
    name: `[spike ${stamp}] Free grant test`,
    recurringInterval: "month",
    prices: [{ amountType: "free" }],
    ...orgField,
  });
  productId = product.id;
  await polar.products.updateBenefits({
    id: product.id,
    productBenefitsUpdate: { benefits: [benefit.id] },
  });
  console.log(`✓ Created free product + attached benefit: ${product.id}`);

  // 3. The customer must exist before we can subscribe them by external id.
  await polar.customers.create({ email, externalId, ...orgField });
  customerCreated = true;
  console.log(`✓ Created customer (externalId=${externalId})`);

  // 4. Baseline — a fresh customer should have no balance on this meter yet.
  const before = await readMeter();
  console.log(`\n• BEFORE subscription: ${fmt(before)}`);

  // 5. The silent grant path: subscribe the external customer to the free
  //    product. "No initial order will be created and no confirmation email
  //    will be sent." The meter_credit benefit grant fires asynchronously, so
  //    we poll until the credited units land.
  const sub = await polar.subscriptions.create({
    productId: product.id,
    externalCustomerId: externalId,
  });
  console.log(`\n✓ subscriptions.create → id=${sub.id} status=${sub.status}`);
  console.log("  Polling for the grant to land...");
  afterSub = await pollMeter("after-create", GRANT_UNITS);

  if ((afterSub?.credited ?? 0) < GRANT_UNITS) {
    console.log(
      "\n⚠ Grant did not reach the meter within the poll window — cannot judge",
    );
    console.log(
      "  claw-back. Increase POLL_ATTEMPTS, or check the benefit's meterId and",
    );
    console.log("  that this meter belongs to the same org as the token.");
  } else {
    // 6. THE QUESTION: revoke the subscription, then watch the meter. If
    //    `credited` stays at GRANT_UNITS, revoke does not claw back and the
    //    subscribe→revoke one-time grant is viable.
    const revoked = await polar.subscriptions.revoke({ id: sub.id });
    console.log(`\n✓ subscriptions.revoke → status=${revoked.status}`);
    console.log("  Watching the meter for a claw-back...");
    afterRevoke = await pollMeter("after-revoke");
  }
} catch (error) {
  runError = error;
  const status = (error as { statusCode?: number }).statusCode;
  console.error("\n✗ Spike failed:", error instanceof Error ? error.message : String(error));
  if (status === 401) {
    console.error(`  → 401: the token isn't valid for POLAR_SERVER=${server}. Polar sandbox`);
    console.error("    and production are SEPARATE systems with separate tokens — the repo");
    console.error("    `.env` token is production. Use one issued by the matching dashboard");
    console.error("    (sandbox.polar.sh for sandbox).");
  } else if (status === 404) {
    console.error(`  → 404: a resource (likely the meter id) doesn't exist in ${server}.`);
    console.error("    Unset POLAR_CREDITS_METER_ID to auto-create a throwaway meter, or pass");
    console.error("    one that exists in this environment.");
  }
  process.exitCode = 1;
} finally {
  if (keep) {
    console.log("\n(--keep) Leaving throwaway objects for inspection:");
    console.log(
      `  benefit=${benefitId ?? "—"} product=${productId ?? "—"} customer=${externalId}` +
        (meterCreated ? ` meter=${meterId}` : ""),
    );
  } else {
    console.log("\nCleaning up throwaway objects...");
    // Deleting the customer cancels any leftover subscription and revokes its
    // grants, so it covers the not-yet-revoked failure path too.
    if (customerCreated) {
      try {
        await polar.customers.deleteExternal({ externalId });
        console.log("  ✓ deleted customer");
      } catch (e) {
        console.log("  • customer cleanup skipped:", (e as Error).message);
      }
    }
    if (benefitId) {
      try {
        await polar.benefits.delete({ id: benefitId });
        console.log("  ✓ deleted benefit");
      } catch (e) {
        console.log("  • benefit cleanup skipped:", (e as Error).message);
      }
    }
    // Products have no delete endpoint in the SDK; the inert free product just
    // lingers in sandbox. Log it so it can be archived in the dashboard if you care.
    if (productId) console.log(`  • product ${productId} left in place (no delete API; archive in dashboard if desired)`);
    if (meterCreated) console.log(`  • meter ${meterId} left in place (meters have no delete API)`);
  }
}

// ── Verdict ──────────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(64));
console.log("VERDICT");
console.log("═".repeat(64));

const grantLanded = (afterSub?.credited ?? 0) >= GRANT_UNITS;
const creditedAfterRevoke = afterRevoke?.credited ?? 0;
const clawedBack = afterRevoke === null || creditedAfterRevoke < GRANT_UNITS;

if (runError !== undefined) {
  console.log("✗ ERRORED — the run aborted before any conclusion (see the error above).");
  console.log("  Nothing about claw-back was tested; fix the error and re-run.");
} else if (!grantLanded) {
  console.log("⚠ INCONCLUSIVE — the grant never landed within the poll window.");
  console.log("  Increase POLL_ATTEMPTS / POLL_DELAY_MS, or confirm the benefit's meterId.");
} else if (clawedBack) {
  console.log("✗ REVOKE CLAWS BACK THE CREDITS.");
  console.log(`  credited ${GRANT_UNITS} → ${afterRevoke === null ? "meter removed" : creditedAfterRevoke}.`);
  console.log("  → The subscribe-then-revoke one-time grant is NOT viable.");
  console.log("  → Fallback: keep the subscription as a recurring free tier (long");
  console.log("    interval, rollover:false) and reopen the '$2 one-time' decision");
  console.log("    in MONETIZATION.md (Item 3).");
} else {
  console.log("✓ REVOKE DOES NOT CLAW BACK.");
  console.log(`  credited stayed at ${creditedAfterRevoke}, balance ${afterRevoke?.balance ?? 0} after revoke.`);
  console.log("  → The free $2 / 200-credit ONE-TIME grant (Item 3) is VIABLE:");
  console.log("    subscriptions.create on the free product, then subscriptions.revoke");
  console.log("    immediately to stop renewal. Enforce one-per-identity in our DB.");
}
console.log("═".repeat(64));
