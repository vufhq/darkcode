# Deploying DarkCode to production

This is the ordered runbook to take DarkCode live on **darkcode.sh**. Most of
the code/config is already in the repo; the steps below are the dashboard +
DNS work that has to happen in your accounts.

## Architecture

```
darkcode.sh            → Vercel    website (marketing + billing dashboard)
darkcode.sh/install.sh → Vercel    one-line CLI installer (static file)
api.darkcode.sh        → Railway   the Hono/Bun API (Docker)
GitHub Releases        → vufhq/darkcode   prebuilt CLI binaries
```

The API is **not** on Vercel on purpose: it's a long-lived Bun server
(`Bun.serve`, a background Polar-retry sweeper, streaming turns up to 240s,
persistent Postgres/Redis) — none of which fit serverless. It runs as a
container on Railway and is reached at the `api.` subdomain of your Vercel
domain, so everything still lives under one brand.

## Prerequisites

- [x] Domain **darkcode.sh** (you have it, on Vercel)
- [x] Vercel account
- [x] GitHub repo **github.com/vufhq/darkcode**
- [ ] Railway account (for the API + Postgres + Redis)
- [ ] Clerk **production** instance
- [ ] Polar account in **production** mode
- [ ] Moonshot API key (powers the hosted "Kimi K2.6" model)
- [ ] The website repo pushed to GitHub (e.g. `vufhq/darkcode-website`) for Vercel to import

---

## Step 1 — API on Railway (`api.darkcode.sh`)

1. **New project → Deploy from GitHub repo** → pick `vufhq/darkcode`. Railway
   detects the `Dockerfile` (via `railway.toml`).
2. **Add Postgres** (New → Database → PostgreSQL). Railway sets `DATABASE_URL`.
   If you put Postgres behind PgBouncer, also set `DIRECT_DATABASE_URL` to the
   non-pooled URL (Prisma migrate needs it).
3. **Add Redis** (New → Database → Redis). Copy its URL into `REDIS_URL`
   (enables cross-replica rate-limiting + idempotency).
4. **Set the service variables** — see the [Production env reference](#production-env-reference) below.
5. **Custom domain:** service → Settings → Networking → add `api.darkcode.sh`.
   Railway shows a CNAME target (`*.up.railway.app`) — you'll add that DNS
   record in Step 5.
6. **Deploy.** On boot the container runs `prisma migrate deploy` (idempotent,
   advisory-locked) then starts the server. A **fresh** Railway Postgres needs
   no baselining. (Only if you reuse a database that was seeded with
   `db:push` — it has the tables but no `_prisma_migrations` history — baseline
   it first: `prisma migrate resolve --applied 0_init` → `… 1_audit_log` →
   `… 2_phase3_session_compaction`.)
7. Health check is `/healthz`; Railway restarts on failure.
8. Once `REDIS_URL` is set you can raise `numReplicas` in `railway.toml` above 1.

---

## Step 2 — Clerk production

Create a **production** Clerk instance (Clerk requires its own DNS records —
`clerk`, `accounts`, `clkmail`, etc. — follow Clerk's "Deploy to production"
wizard and add those CNAMEs in Step 5).

Two things consume Clerk:

**A. The website** (Clerk React SDK, end-user sign-in):
- Copy the `pk_live_…` publishable key → website env `VITE_CLERK_PUBLISHABLE_KEY` (Step 4).
- Add `darkcode.sh` as an allowed application domain.

**B. The CLI OAuth app** (browser PKCE flow):
- Configure → OAuth applications → add one named `DarkCode`.
- Scopes: `openid`, `email`, `profile`, `offline_access`.
- Turn on **Public** (required for PKCE) and **Consent screen**.
- Redirect URIs:
  - `https://api.darkcode.sh/auth/callback` (production)
  - `http://localhost:3000/auth/callback` (local dev — fine to keep on the same app)
- Copy these into the **Railway** API env:
  - `CLERK_FRONTEND_API`, `CLERK_OAUTH_CLIENT_ID`, `CLERK_OAUTH_CLIENT_SECRET`,
    `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`.

> The shipped CLI binary bakes in **only** the API URL. It fetches the public
> Clerk params (`clerkFrontendApi`, `clientId`) from `GET /auth/config` at login
> time, so rotating Clerk config never requires a CLI rebuild.

---

## Step 3 — Polar production

Switch Polar to **production** and recreate the meter/product (sandbox config
doesn't carry over):

| Setting | Value |
|---|---|
| Meter name | `darkcode_credits` |
| Filter | Name equals `darkcode_usage` |
| Aggregation | Sum over property `credits` |

Then create a credits benefit + one-time product and attach the benefit. Copy
into the **Railway** API env:
- `POLAR_ACCESS_TOKEN`, `POLAR_PRODUCT_ID`, `POLAR_CREDITS_METER_ID`
- `POLAR_SERVER=production`

> The event shape is exactly `{ name: "darkcode_usage", metadata: { credits } }`.
> Don't rename the event or the `credits` key without updating the meter filter.

**Recurring tiers (free + Pro).** Once the meter exists, provision the two
subscription tiers against it. Each is a product carrying a `meter_credit`
benefit on the **same** `POLAR_CREDITS_METER_ID`, so the existing balance
gauge/gate read them with zero code changes. Run locally with the production
`.env` loaded (bun auto-loads it):

```sh
bun run provision:free-tier --allow-production   # prints POLAR_FREE_GRANT_PRODUCT_ID
bun run provision:pro-tier  --allow-production   # prints POLAR_PRO_PRODUCT_ID
```

Copy each printed product id into the Railway API env. Both features are
**inert until their id is set**: with `POLAR_FREE_GRANT_PRODUCT_ID` unset the
free grant is a no-op; with `POLAR_PRO_PRODUCT_ID` unset `/pro` returns 503 and
premium-model tiering (Opus / GPT-5.4 / Gemini Pro) stays off. Tune allotments
at provision time via `POLAR_FREE_GRANT_CREDITS`, `POLAR_PRO_CREDITS`,
`POLAR_PRO_PRICE_USD`. Both scripts are idempotent (skip if the id already
resolves; `--force` to override).

> Not yet verified in production: that the `rollover:false` benefit refreshes
> the allowance each billing cycle, and how free + Pro + pay-as-you-go credits
> net against each other on the **shared** meter. Confirm with a short-interval
> sandbox run before relying on either tier (see MONETIZATION.md "Left before
> launch").

---

## Step 4 — Website on Vercel (`darkcode.sh`)

1. **Import** the website repo (`vufhq/darkcode-website`) into Vercel. The
   committed `vercel.json` sets framework=Vite, build `npm run build`, output
   `dist`, SPA rewrites, and serves `/install.sh` + `/install.ps1`.
2. **Environment variables** (Production):
   - `VITE_CLERK_PUBLISHABLE_KEY` = `pk_live_…`
   - `VITE_DARKCODE_API_URL` = `https://api.darkcode.sh`
   - `VITE_SOURCE_REPO_URL` = `https://github.com/vufhq/darkcode`
3. **Domains:** add `darkcode.sh` and `www.darkcode.sh` to the project.
4. Deploy. Verify `https://darkcode.sh/install.sh` returns the script.

---

## Step 5 — DNS (managed at Vercel)

In the Vercel dashboard for **darkcode.sh** → Domains/DNS:

| Record | Type | Points to |
|---|---|---|
| `darkcode.sh` (apex) | A / ALIAS | Vercel (auto when you add the domain to the website project) |
| `www` | CNAME | Vercel |
| `api` | CNAME | the Railway target from Step 1.5 (`*.up.railway.app`) |
| Clerk records | CNAME | the values from Clerk's production wizard (Step 2) |

---

## Step 6 — Release the CLI binaries

The install link only works if the **release assets are publicly
downloadable**. A private repo's release assets 404 for anonymous users, so
either:
- make `vufhq/darkcode` **public**, or
- publish binaries from a public repo (point the installers/workflow at it via
  `DARKCODE_REPO`), or host them on a CDN/R2 and adjust the install scripts.

Then cut a release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The `Release` workflow builds standalone binaries on native runners
(mac arm64/x64, linux x64/arm64, windows x64), gzips/zips them with SHA-256
sidecars, and attaches them to the GitHub Release. The install scripts pull
from `releases/latest`.

---

## Step 7 — Smoke test

```bash
curl -fsSL https://darkcode.sh/install.sh | sh
darkcode --version
darkcode                # boots the TUI
# inside: /login → browser OAuth → /upgrade to buy credits → chat a turn
```

Check: login round-trips through `api.darkcode.sh/auth/callback`; a metered
chat decrements credits; `/upgrade` opens Polar checkout and returns to
`darkcode.sh/dashboard/billing`.

---

## Production env reference

Set these on the **Railway API service**. Bold = required (the server refuses
to boot without them).

| Variable | Value |
|---|---|
| **`NODE_ENV`** | `production` |
| **`DATABASE_URL`** | from Railway Postgres |
| `DIRECT_DATABASE_URL` | non-pooled URL if using PgBouncer |
| **`MOONSHOT_API_KEY`** | Moonshot key (hosted Kimi K2.6) |
| **`CLERK_FRONTEND_API`** | Clerk prod |
| **`CLERK_OAUTH_CLIENT_ID`** | Clerk CLI OAuth app |
| **`CLERK_OAUTH_CLIENT_SECRET`** | Clerk CLI OAuth app |
| **`CLERK_PUBLISHABLE_KEY`** | `pk_live_…` |
| **`CLERK_SECRET_KEY`** | `sk_live_…` |
| **`JWT_SECRET`** | long random string |
| **`POLAR_ACCESS_TOKEN`** | Polar prod token |
| **`POLAR_PRODUCT_ID`** | credits product id |
| **`POLAR_CREDITS_METER_ID`** | meter id |
| `POLAR_FREE_GRANT_PRODUCT_ID` | recurring free-tier product (`provision:free-tier`); unset = free tier off |
| `POLAR_PRO_PRODUCT_ID` | Pro subscription product (`provision:pro-tier`); unset = `/pro` 503s + premium tiering off |
| `POLAR_SERVER` | `production` |
| `WEBSITE_URL` | `https://darkcode.sh` |
| `CORS_ORIGINS` | `https://darkcode.sh,https://www.darkcode.sh` |
| `REDIS_URL` | from Railway Redis |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `GOOGLE_API_KEY` | optional — lets users run those models on credits without their own key |
| `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_RELEASE` | optional observability |
| `CHAT_STREAM_TIMEOUT_MS` | optional (default 240000) |

CLI binary env (baked default shown; overridable for dev):
| Variable | Default |
|---|---|
| `DARKCODE_API_URL` | `https://api.darkcode.sh` |
