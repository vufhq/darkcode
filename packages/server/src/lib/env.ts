import { z } from "zod";

const NonEmpty = z.string().min(1);
const Optional = z.string().min(1).optional();

const schema = z.object({
  // Runtime
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),

  // Max wall-clock duration (ms) for a single streaming model turn — covers
  // the optional compaction summarizer call plus the main stream. Bounds a
  // hung or trickling upstream provider so it can't pin a request open. Keep
  // it under Bun's socket idleTimeout (255s).
  CHAT_STREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(240_000),

  // Database. DATABASE_URL is the runtime (pooled) connection. The optional
  // DIRECT_DATABASE_URL points at the non-pooled endpoint and is used only by
  // Prisma migrate, which can't run over PgBouncer's transaction pool.
  DATABASE_URL: NonEmpty,
  DIRECT_DATABASE_URL: Optional,

  // Hosted Kimi K2.6 (Moonshot upstream)
  MOONSHOT_API_KEY: NonEmpty,
  MOONSHOT_BASE_URL: z.string().url().default("https://api.moonshot.ai/v1"),
  DARKCODE_BACKING_MODEL: z.string().default("kimi-k2.6"),
  // Model used for the server-side `webSearch` tool. Must be one that
  // supports Moonshot's `$web_search` builtin function — kimi-k2.6 (with
  // thinking enabled) or kimi-k3. Separate from the chat model on purpose:
  // search runs for every user regardless of which model they chat with.
  MOONSHOT_SEARCH_MODEL: z.string().default("kimi-k2.6"),

  // Hosted provider API keys (optional — used when users don't BYOK)
  ANTHROPIC_API_KEY: Optional,
  OPENAI_API_KEY: Optional,
  DEEPSEEK_API_KEY: Optional,
  GOOGLE_API_KEY: Optional,

  // Clerk
  CLERK_FRONTEND_API: NonEmpty,
  CLERK_OAUTH_CLIENT_ID: NonEmpty,
  CLERK_OAUTH_CLIENT_SECRET: NonEmpty,
  CLERK_PUBLISHABLE_KEY: NonEmpty,
  CLERK_SECRET_KEY: NonEmpty,
  JWT_SECRET: NonEmpty,

  // Polar billing
  POLAR_ACCESS_TOKEN: NonEmpty,
  POLAR_PRODUCT_ID: NonEmpty,
  POLAR_SERVER: z.enum(["sandbox", "production"]).default("sandbox"),
  POLAR_CREDITS_METER_ID: NonEmpty,
  // Free recurring credit tier (Item 3): the $0 recurring product carrying the
  // meter_credit benefit, created by `bun run provision:free-tier`. Unset = the
  // free tier is disabled and `ensureFreeTierGrant` is a no-op.
  POLAR_FREE_GRANT_PRODUCT_ID: Optional,
  // Pro subscription tier (Item 4): the paid recurring product carrying the
  // monthly included-credits benefit, created by `bun run provision:pro-tier`.
  // Unset = Pro is disabled — `/checkout/pro` 503s and premium-model tiering is
  // inert (premium models stay available to anyone on credits, current
  // behavior). Set it to flip on Pro checkout + premium gating.
  POLAR_PRO_PRODUCT_ID: Optional,

  // Public URL of the website (no trailing slash). Used as the Polar
  // checkout success/return URL so users land back on /dashboard/billing
  // after paying, where the page refreshes the credit balance.
  WEBSITE_URL: z.string().url().default("http://localhost:5173"),

  // Observability (optional)
  SENTRY_DSN: Optional,
  SENTRY_RELEASE: Optional,
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

  // CORS — comma-separated allowlist of browser origins for the website.
  // Defaults to the local Vite dev origin; set this to your deployed website
  // origin(s) in production. "*" is still honored (with credentials disabled)
  // but is intentionally NOT the default — a wildcard lets any site call the
  // authenticated API. The CLI is a non-browser client and ignores CORS.
  CORS_ORIGINS: z.string().default("http://localhost:5173"),

  // Rate-limit / cache store. Leave empty to use the in-memory fallback.
  REDIS_URL: Optional,

  // Ollama local inference (optional). Defaults to the standard local endpoint.
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434/v1"),
  // Override the Ollama model id (e.g. "llama3.2", "codestral"). Defaults to
  // the upstreamModelId set in the registry entry.
  OLLAMA_DEFAULT_MODEL: Optional,
});

export type Env = z.infer<typeof schema>;

function parseEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("\n");
  // Print before throwing — pino isn't initialized yet at this point.
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  throw new Error("Invalid environment configuration");
}

export const env: Env = parseEnv();

export const isProduction = env.NODE_ENV === "production";
