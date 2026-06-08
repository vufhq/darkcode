# DarkCode — Monetization & "Selling Features" Roadmap

> Goal: make DarkCode **sustainably pay for itself** — margin on convenience, not gouging.
> This is a strategy doc, not a spec. Sequence matters more than the feature list.

## Core thesis

The billing rail **already exists** — this is a packaging/trust problem, not a "build a payment system" problem:

- Usage-metered credits on the hosted Kimi model, pegged **1 credit = $0.01** (`packages/server/src/lib/credits.ts`, `USD_PER_CREDIT`).
- Per-turn usage ingested to Polar (`lib/polar.ts` + `lib/polar-outbox.ts`).
- `/balance`, `/usage`, `/subscription`, `/transactions`, `/checkout`, `/portal` all wired (`routes/billing.ts`).
- **BYOK is free** (user's key → `isMetered: false`), with a **credit-depleted → BYOK fallback** so paid users never hard-stop (`routes/chat.ts`).

**The real question is not "how do I add selling" — it's "why does someone pay me instead of using free BYOK," and "is the paid path trustworthy enough to charge for."**

Funnel: `BYOK free (on-ramp) → hosted trial credits → paid (subscription + premium features)`.

---

## Tier 1 — Make the money machine trustworthy + convert (small eng, highest ROI)

Do this **before** any new phase. New features are rarely the revenue bottleneck; trust + conversion + recurring packaging are. (Context: `c6b6018` fixed paid users seeing `$0` credits from a meter-id misconfig — that bug class churns payers faster than any feature wins them.)

1. **Never let a billing glitch look like "you're broke." — ✅ DONE**
   When the Polar balance fetch fails, the CLI must say *"couldn't load credits — this is on us"* and **not block**, instead of showing `0`. Pair the existing boot guard with a **status-bar credit gauge** (reuse the `ctx N%` gauge pattern in `components/status-bar.tsx`) + low-balance warning.
2. **Frictionless top-up at the moment of refusal. — ✅ DONE**
   When a metered call is denied for low credits, print the `/upgrade` checkout link inline, right there. One click, back to work.
3. **Free credit grant on signup — ✅ path decided 2026-06-06: recurring free tier (revised from "$2 one-time"; claw-back killed the one-time silent path). Verify `rollover:false` refresh before launch.**
   ~6–8 substantial sessions: enough to *feel* the hosted model before paying — the funnel hinge. Gate behind OAuth signup + a per-IP velocity limit. The abuse ceiling is low at $2, so don't over-build the guard (see Tier 3).
4. **A subscription tier, not just pay-as-you-go — Pro $20/mo (Cursor anchor). — ✅ DONE (scaffolded 2026-06-08; inert until `POLAR_PRO_PRODUCT_ID` provisioned)**
   `getSubscription` already exists. Predictable MRR ≫ lumpy top-ups, and it's mostly **packaging + a tier check**, not new infra. Pro = included credits worth **less than $20** (so the subscription itself carries the margin — see "Pricing & margin") + premium-model tiering + the Tier-2 dashboard. Add annual billing (a Polar toggle) for cash flow + retention.

> None of Tier 1 is a new "phase" — it's wiring you mostly already have. Highest leverage for "support more work."

### Build status (Tier 1)

Branch `fix/polar-credits-meter-boot-guard`, uncommitted as of 2026-06-06. Verified: server `tsc` exit 0; `bun test` 117/117; both Polar scripts `tsc`-clean + smoke-tested.

**✅ Item 1 — credit gauge + "this is on us"**
- `packages/cli/src/lib/credits.ts` (new) — `fetchCreditsBalance()` returns `{status:"ok", credits} | {status:"unavailable"}`; a failed/non-OK/non-finite response is **never coerced to 0**.
- `providers/prompt-config` holds `credits` state; `screens/session.tsx` loads it on entry and refreshes after each settled turn **on the hosted model only** (BYOK turns don't spend credits); `components/status-bar.tsx` renders `N cr` (amber <50, red <10) or a dim `cr —` when unavailable.
- **Server gate now fails open:** `routes/chat.ts` previously returned **503** when the Polar balance fetch threw, hard-blocking paying users on a billing-system blip. It now logs + captures and lets the turn proceed (still metered via the outbox). Only exposure: a genuinely-$0 user sneaking one turn during a Polar outage. Decision recorded; characterized in `routes/credit-fallback.test.ts` (`gatesForDepletion`).

**✅ Item 2 — frictionless top-up at refusal**
- `routes/chat.ts` 402 now carries a stable `code: "credits_depleted"` (don't string-match the human message).
- `cli/src/lib/http-errors.ts` gained `parseChatError` (lifts `{error, code}`); `formatChatErrorMessage` is now a thin back-compat wrapper. Tested in `http-errors.test.ts`.
- `components/messages/error-message.tsx` gained an accent `hint` line; `session.tsx` shows *"Your conversation is saved — run /upgrade to add credits and continue."* on a `credits_depleted` refusal.

**⏸ Deferred — one-keystroke top-up.** A raw `u` binding collides with typing `u` in the prompt box (screen-level `useKeyboard` fires globally while the textarea is focused). The clean version is a pushed keyboard-layer modal that unfocuses the input, but it manages focus state that can't be verified without a live TUI — landing it blind risks trapping the keyboard. Hold until it can be runtime-verified.

**✅ Item 3 — recurring free tier (scaffolded 2026-06-06; inert until provisioned).** Ships safely off until `POLAR_FREE_GRANT_PRODUCT_ID` is set.
- **Provisioning:** `scripts/provision-free-tier.ts` (`bun run provision:free-tier`) creates a `meter_credit` benefit (75 cr, `rollover:false`, on `POLAR_CREDITS_METER_ID`) + a $0 recurring-monthly product, attaches them, prints the product id. Idempotent (skips if `POLAR_FREE_GRANT_PRODUCT_ID` already resolves; `--force` overrides), production-guarded (`--allow-production`). Run once per env.
- **Grant:** `ensureFreeTierGrant({externalCustomerId,email})` in `lib/polar.ts` — idempotent via Polar (skips if already subscribed to the free product), creates the customer if absent (email from Clerk via `getUserPrimaryEmail`, `lib/auth.ts`), then `subscriptions.create`. No-op when the product-id env is unset.
- **Trigger:** fire-and-forget from `GET /billing/balance` (no Clerk signup webhook exists → "first authenticated request" is de-facto signup), throttled by `claimIdempotencyKey` (~once/10min/user) and idempotent in Polar. New audit action `billing.free_tier_granted`; new optional env `POLAR_FREE_GRANT_PRODUCT_ID`.
- **Allowance:** 75 cr/mo (`POLAR_FREE_GRANT_CREDITS` overrides at provision time).
- **Left before launch:** (1) provision in sandbox + run the server to confirm a fresh user lands 75 (needs a *sandbox* credits meter — the `.env` meter is prod); (2) runtime-verify the `rollover:false` per-cycle refresh — **tooling now exists: `bun run verify:tiers` (`scripts/verify-tiers.ts`)** automates the shared-meter netting check and hands back a `--check <externalId>` re-check for the time-gated refresh (a cycle must still elapse, or use a shorter `VERIFY_INTERVAL`); (3) known minor race — a brand-new user's first hosted turn can hit the gate before the async grant lands (sub created in ~1s, credit shortly after) — harden later by awaiting in the gate or a dedicated post-login claim endpoint; (4) **✅ DONE — per-IP velocity abuse guard** (`lib/free-grant-guard.ts`): soft cap of 10 new grants/IP/24h on the Redis-or-memory store, counts only landed grants (peeking never increments, so shared NAT/CGNAT returning users aren't penalised), fails open; over-cap attempts audit `billing.free_tier_blocked`.

**✅ Item 4 — Pro $20/mo subscription + premium-model tiering (scaffolded 2026-06-08; inert until provisioned).** Ships safely off until `POLAR_PRO_PRODUCT_ID` is set: with it unset, `/pro` 503s and premium models stay available to anyone on credits (today's behavior). Server `tsc` exit 0; `bun test` 127/127 (10 new in `routes/pro-gate.test.ts`); both Polar provision scripts `tsc`-clean.
- **Provisioning:** `scripts/provision-pro-tier.ts` (`bun run provision:pro-tier`) creates a `meter_credit` benefit (`POLAR_PRO_CREDITS`, default 900, `rollover:false`, on `POLAR_CREDITS_METER_ID`) + a paid recurring-monthly product (`POLAR_PRO_PRICE_USD`, default $20) and attaches them. Idempotent (skips if `POLAR_PRO_PRODUCT_ID` resolves; `--force` overrides), production-guarded (`--allow-production`). Mirrors the free-tier script; the only new primitive is the `fixed` price shape (`{ amountType:"fixed", priceAmount:<cents>, priceCurrency:"usd" }`, verified against the SDK type). Included credits (≈$9) sit deliberately under the $20 price so the **subscription carries the margin** (per "Pricing & margin").
- **Checkout:** Pro is a *paid* product → it must go through `checkouts.create`. New `POST /billing/checkout/pro` (mirrors `/checkout`, targets `POLAR_PRO_PRODUCT_ID`; 503 `code:"pro_unavailable"` when unset). `createCheckoutUrl` now takes an optional `productId` (defaults to the PAYG top-up product — `/checkout` is untouched and back-compat). CLI: `lib/upgrade.ts` `openProCheckout()`, new `/pro` slash command. The recurring meter-credit benefit re-credits each cycle on the **same meter** the gauge/gate already read — zero read-path change, same as the free tier.
- **Premium-model tiering:** registry gains `tier?:"pro"` (`packages/shared/src/models.ts`), marking **claude-opus-4-6 / gpt-5.4 / gemini-2.5-pro**; helper `isProTierModel()`. `chat.ts` gates *inside* the `resolvedModel.isMetered` branch (so **BYOK is never gated** — the user's own key always works) and only when `POLAR_PRO_PRODUCT_ID` is set: a non-Pro user on a premium hosted model gets a **402 `code:"pro_required"`** (CLI renders a `/pro`-or-`/keys`-or-`/models` hint, like the `credits_depleted` affordance). The Pro check (`hasActiveProSubscription`) **fails open** on a Polar error — same "don't wall a paying user out on a billing blip" stance as the credit gate. Models dialog badges premium entries "Pro" (unless the user has a BYOK key for them → "BYOK"). `getSubscription` now prefers the paid Pro sub over the free-tier sub when a user holds both, and exposes `isPro`.
- **Left before launch:** (1) provision Pro in *sandbox* + run a Pro checkout to confirm the included credits land on the meter and the gate flips (premium models go from "credits" to "needs Pro"); (2) runtime-verify the per-cycle credit refresh (shares the `rollover:false` open item with Item 3 — same meter); (3) tune the exact included-credit allotment (`POLAR_PRO_CREDITS`) and whether free + Pro should share the prod meter or use separate meters — **`bun run verify:tiers` now empirically checks the shared-meter question**: it grants free + Pro + PAYG-like benefits on one meter and asserts they stack additively and that a `darkcode_usage` debit nets against the combined pool; (4) the Pro check adds one `subscriptions.list` call per premium hosted turn — cache it (Redis/idempotency) if it shows up in latency.

**✅ Spike done — grant mechanism (resolved 2026-06-04, against `@polar-sh/sdk` 0.47.1).**

**The single primitive (both items share it): a Meter Credit benefit.** `benefits.create({ type: "meter_credit", properties: { units, rollover, meterId } })` pointed at the **existing** `POLAR_CREDITS_METER_ID`. Credits enter a meter *only* by granting such a benefit — the grant emits a `system` event `meter.credited` that raises `creditedUnits`, and a meter's `balance = creditedUnits − consumedUnits`. So the **read side is already done**: `getAvailableCreditsBalance` reads `activeMeters[].balance`, and our `darkcode_usage` debits are the `consumedUnits`. Grant on the *same* meter id and credits surface on the gauge/gate we already ship — **zero read-path or meter changes.** (Naming gotcha: the SDK's doc-comments say `meter_unit`, but the literal `type` discriminator is `"meter_credit"`.)

**Delivery — the only two programmatic ways to put the benefit on a customer:**
- **Item 4 — Pro $20/mo (paid):** recurring meter-credit benefit on the Pro product, delivered through the **`checkouts.create`** flow we already use for top-ups (paid products *must* go through checkout). Renews → re-credits each cycle. `rollover: false` = use-it-or-lose-it monthly allotment (fits "included credits < $20"); `rollover: true` = credits stack.
- **Item 3 — free $2 / 200 credits:** `subscriptions.create` on a free product *is* silent, but it's **recurring** and **revoke claws back** (verified below) — so there is **no silent one-time primitive**. The remaining options are a product decision (see **"Item 3 path"** below).

**✅ Verified (2026-06-06, sandbox `bun run spike:grant`): REVOKE CLAWS BACK.** Balance went 0 → **200** after `subscriptions.create`; after `subscriptions.revoke` it held at 200 for ~1.5s then dropped to **0**. The claw-back is *asynchronous* — you can't grab the credits before it lands. Lesson: meter-credit `creditedUnits` track **currently-active grants**, not a permanent ledger — when a grant ends (subscription revoke/cancel/lapse, customer/benefit deletion) its credits vanish. Corollaries: a **one-time order** grant (the paid top-up today) *persists* because nothing revokes it; **subscription**-included credits (Item 4) correctly refresh each cycle and drop on cancel — exactly the behavior we want there. Only **Item 3** (free, one-time, silent) is left without a primitive.

**Item 3 path — DECIDED 2026-06-06: option (b), recurring free tier** (reverses "$2 one-time"; see Decisions table). Options recorded for the record:
- **(a) $0 one-time product via the existing `checkouts.create` flow.** A completed one-time order grants *persistent* credits just like the paid top-up — preserves "$2 one-time" and reuses infra we already have. Cost: one user click ("claim your free credits"), not silent at signup. Fully-silent server-side completion via `checkouts.clientConfirm` is plausible but needs its own ~15-min spike.
- **(b) Recurring free tier. ✅ CHOSEN.** Keep the free `subscriptions.create` subscription (never revoke), `rollover:false` → a refreshing monthly allowance. Silent + already proven by this spike. But it's a *permanent free tier*, not a one-time trial — reopens the strategy decision (could cannibalize conversion; doubles as a re-engagement hook).
- **(c) DB-tracked free grant.** Our Postgres owns "one $2 grant per identity"; Polar holds only paid credits; the gate sums both. Full control over one-time/abuse semantics, but a parallel ledger to maintain.

**Ruled out (don't chase these):** you cannot ingest a credit yourself (`meter.credited` is `source: "system"` — the ingest API is debit-only); there is **no** `orders.create`, **no** `benefitGrants.create`, and **no** balance-adjust on `meters`/`customerMeters`. `balance.credit_order` is the *opposite* (spending balance to pay an order), not granting.

**One-time setup (per environment, all SDK-provisionable):** create 1 free product + 1 Pro product (`products.create` / `products.updateBenefits`), each carrying a meter-credit benefit on `POLAR_CREDITS_METER_ID`; capture their ids as env (`POLAR_FREE_GRANT_PRODUCT_ID`, `POLAR_PRO_PRODUCT_ID`).

**Spike complete.** The verifier `scripts/grant-mechanism-spike.ts` (`bun run spike:grant`) confirmed the claw-back. The grant mechanism for the *paid top-up* and *Pro* (Item 4) is settled — persistent one-time-order credits / per-cycle subscription credits, both via `checkouts.create` + a meter-credit benefit. **Next is the "Item 3 path" decision above**; if we pick (a) and want it fully silent, the follow-up is a small `checkouts.clientConfirm` spike (extend the same script). One-time setup whichever path: 1 Pro product + (for a/b) 1 free product, each carrying a meter-credit benefit on `POLAR_CREDITS_METER_ID`; capture ids as env (`POLAR_FREE_GRANT_PRODUCT_ID`, `POLAR_PRO_PRODUCT_ID`).

(Spike-run gotchas, for reference: needs a **sandbox** `POLAR_ACCESS_TOKEN` from sandbox.polar.sh + `POLAR_SERVER=sandbox` passed inline — the repo `.env` is production and a prod token 401s on sandbox; `POLAR_CREDITS_METER_ID` is optional, auto-creates a throwaway; throwaway emails must use a real TLD, not `.invalid`.)

---

## Tier 2 — The actual "selling features" (justify the subscription)

Things free BYOK **can't** replicate because they need *your* server:

| Feature | Why it sells | Eng cost | Maps to |
|---|---|---|---|
| **Hosted session history + web dashboard** | Sessions already persist in Postgres — expose a web UI: browse past sessions, usage/cost analytics. Retention surface *and* upsell surface. | Medium (mostly surfacing stored data) | new |
| **Remote attach / multi-device** ("start on laptop, resume on phone") | Naturally premium; impossible with local-only BYOK. | High (auth/security surface) | **P7** (designed, unbuilt) |
| **Model tiering** | Gate best/priciest hosted models behind Pro; cheap hosted model on free tier. | Low (registry already carries `pricing`) | existing `models.ts` |
| **Spec-driven dev workflow (Kiro)** | Differentiator / "pro workflow" feel. | High; BYOK can use it too → weaker *paywall* | **P5** (unbuilt) |

**First Tier-2 build to pick: hosted session history + thin web dashboard.** Mostly surfaces data you already store, doubles as retention, natural Pro gate, and none of P7's security risk.

---

## Tier 3 — Margin & ethics levers (no new features)

- **Market the BYOK fallback:** *"Run out of credits? We auto-fall back to your own key — you never get stuck."* Already built; it's the "not greedy" story.
- **Keep BYOK free forever** as the on-ramp / goodwill loss-leader. Charge only for hosted convenience + Tier-2.
- **Abuse guard for free credits:** hosted credits cost you upstream money. Free-grant + multi-signup farming needs a rate/abuse limit (extend existing per-route limits to the signup grant).

---

## Recommended sequence

1. **Tier 1** (trust + convert + subscription tier) — small eng, where revenue actually leaks.
2. **One** Tier-2 flagship: **hosted session history / web dashboard**.
3. Hold **P7 (remote attach)** and **P5 (specs)** until paying users ask. Don't build three unbuilt phases at once.

## Pricing & margin

**Key finding (the reason the answers below land where they do):** hosted Kimi credits are sold at **upstream cost today.** The `darkcode-ai` registry pricing ($0.60 in / $2.50 out per Mtok, `packages/shared/src/models.ts`) is literally what we pay Moonshot, and `credits.ts` resells it 1:1 at `1 credit = $0.01`. So metered usage currently nets **~zero margin** — slightly negative on small turns once Polar/Stripe fees land. Margin has to be *designed in*, not assumed.

- Internal unit stays `1 credit = $0.01` (`credits.ts`); easy to reason about like cents.
- **Credits stay pass-through at cost** — we don't mark up tokens. The honesty is the pitch ("your tokens, no markup").
- **Margin lives in the subscription, not the meter.** Pro $20/mo includes credits worth *less* than $20 and gates premium hosted models (Opus / GPT-5.4 / Gemini Pro) + the Tier-2 dashboard. PAYG-only users are **break-even by design** — they're the on-ramp, not the profit center.
- Subscription *includes* credits, doesn't replace them — keeps pay-as-you-go as the overflow.
- Annual discount = retention + cash flow, ~zero eng in Polar.

## Decisions (resolved 2026-06-04; free-grant revised 2026-06-06)

| Question | Decision | Rationale |
|---|---|---|
| **Hosted positioning** | **Convenience, not budget.** | Kimi-at-cost is *mid-pack* per token — Gemini Flash ($0.15/$0.60), GPT nano ($0.20/$1.25), DeepSeek ($0.27/$1.10) BYOK are all cheaper. Win on zero key setup, one bill, managed reliability + credit-depleted BYOK fallback. "Budget" invites a per-token comparison we lose. |
| **Where margin lives** | **Subscription only** — credits pass-through at cost. | Fits the "not gouging" thesis; PAYG break-even, all margin from Pro + premium-model gating. |
| **Free grant** | **Recurring free tier** — a refreshing monthly allowance via a free subscription + `meter_credit` benefit (`rollover:false`), one subscription per Clerk identity + per-IP velocity limit. *Revised 2026-06-06 from "$2 / 200 one-time".* | Subscribe-then-revoke claws back (verified), so a silent persistent **one-time** grant has no primitive; the recurring tier is silent + proven, and doubles as a re-engagement hook. Trade-off: it's a *permanent* free tier — keep the monthly amount modest to avoid Pro cannibalization. |
| **Pro price** | **$20/mo** (Cursor anchor); included credits < $20 + dashboard + premium tiering. | Default expectation for an AI coding tool; the subscription carries the margin. |

**Still open (decide when building, not blocking):** the **free-tier monthly amount + interval** (suggest ~50–100 credits/month — well under Pro's allotment — at `month` interval); the **`rollover:false` refresh mechanic is documented but NOT empirically verified** — before launch confirm a grant actually resets to the allotment each cycle, and how it nets against accumulated `consumedUnits` + persistent paid credits on the *shared* meter (verify via a short-interval spike, or sidestep by putting free credits on a separate meter); exact included-credit allotment for Pro (start ~800–1000 ≈ $8–10); the annual-discount %; whether PAYG top-ups ever need a small markup.
