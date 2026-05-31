import { z } from "zod";

const NonEmpty = z.string().min(1);
const Optional = z.string().min(1).optional();

const schema = z.object({
  // Runtime
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),

  // Database. DATABASE_URL is the runtime (pooled) connection. The optional
  // DIRECT_DATABASE_URL points at the non-pooled endpoint and is used only by
  // Prisma migrate, which can't run over PgBouncer's transaction pool.
  DATABASE_URL: NonEmpty,
  DIRECT_DATABASE_URL: Optional,

  // Hosted DarkCode AI (Moonshot upstream)
  MOONSHOT_API_KEY: NonEmpty,
  MOONSHOT_BASE_URL: z.string().url().default("https://api.moonshot.ai/v1"),
  DARKCODE_BACKING_MODEL: z.string().default("kimi-k2.6"),

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

  // Public URL of the website (no trailing slash). Used as the Polar
  // checkout success/return URL so users land back on /dashboard/billing
  // after paying, where the page refreshes the credit balance.
  WEBSITE_URL: z.string().url().default("http://localhost:5173"),

  // Observability (optional)
  SENTRY_DSN: Optional,
  SENTRY_RELEASE: Optional,
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

  // CORS — comma-separated allowlist of origins, "*" allows all (default).
  CORS_ORIGINS: z.string().default("*"),

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
