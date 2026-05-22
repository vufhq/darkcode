import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { rateLimitHit, type RateLimitConfig } from "../lib/rate-limit";

type KeyResolver = (c: Context) => string;

type RateLimitOptions = RateLimitConfig & {
  /** Identifier used in the rate-limit key, e.g. "chat" or "auth-callback". */
  bucket: string;
  /** Derives the per-caller key. Falls back to client IP from x-forwarded-for or "anon". */
  keyResolver?: KeyResolver;
};

function clientIp(c: Context) {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return c.req.header("x-real-ip") ?? "anon";
}

export function rateLimit(options: RateLimitOptions) {
  const { bucket, limit, windowMs, keyResolver } = options;
  return createMiddleware(async (c, next) => {
    const caller = keyResolver ? keyResolver(c) : clientIp(c);
    const result = await rateLimitHit(`${bucket}:${caller}`, { limit, windowMs });

    c.header("x-ratelimit-limit", String(result.limit));
    c.header("x-ratelimit-remaining", String(result.remaining));
    c.header("x-ratelimit-reset", String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      c.header("retry-after", String(retryAfterSec));
      const log = c.get("log") as { warn: (o: unknown, m: string) => void } | undefined;
      log?.warn({ bucket, caller, limit, windowMs }, "rate_limit.exceeded");
      return c.json(
        { error: "Too many requests. Please slow down.", retryAfterSec },
        429,
      );
    }

    await next();
  });
}

/** Resolves the key from the authenticated userId; falls back to IP. */
export const userIdOrIp: KeyResolver = (c) => {
  const userId = (c.var as { userId?: string }).userId;
  return userId ?? clientIp(c);
};
