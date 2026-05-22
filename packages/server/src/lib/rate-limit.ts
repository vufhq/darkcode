import { getRedis, isRedisConfigured } from "./redis";
import { logger } from "./logger";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
};

export type RateLimitConfig = {
  limit: number;
  windowMs: number;
};

interface Bucket {
  count: number;
  resetAt: number;
}

// Fallback in-process store. Used when REDIS_URL isn't set, or transiently
// when Redis is unreachable. Bound by a cap so a flood of unique keys can't
// blow up memory. Single-instance only — multi-instance deploys MUST set REDIS_URL.
const memoryStore = new Map<string, Bucket>();
const MEMORY_STORE_CAP = 50_000;

function memoryHit(key: string, { limit, windowMs }: RateLimitConfig): RateLimitResult {
  const now = Date.now();
  const existing = memoryStore.get(key);

  if (!existing || existing.resetAt <= now) {
    if (memoryStore.size >= MEMORY_STORE_CAP) {
      // Drop the oldest entry by insertion order. Map preserves insertion order.
      const first = memoryStore.keys().next().value;
      if (first !== undefined) memoryStore.delete(first);
    }
    const bucket: Bucket = { count: 1, resetAt: now + windowMs };
    memoryStore.set(key, bucket);
    return { allowed: true, remaining: limit - 1, resetAt: bucket.resetAt, limit };
  }

  existing.count += 1;
  return {
    allowed: existing.count <= limit,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    limit,
  };
}

async function redisHit(key: string, { limit, windowMs }: RateLimitConfig): Promise<RateLimitResult> {
  const redis = await getRedis();
  if (!redis) return memoryHit(key, { limit, windowMs });

  const namespaced = `rl:${key}`;
  // INCR + EXPIRE atomically via a multi pipeline. If the key was newly created
  // INCR returns 1 — we set the TTL on that path. Otherwise TTL is already set.
  const tx = redis.multi();
  tx.incr(namespaced);
  tx.pTTL(namespaced);
  const [countRaw, ttlRaw] = (await tx.exec()) as unknown as [number, number];

  let count = Number(countRaw);
  let ttl = Number(ttlRaw);
  if (ttl < 0) {
    await redis.pExpire(namespaced, windowMs);
    ttl = windowMs;
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt: Date.now() + ttl,
    limit,
  };
}

export async function rateLimitHit(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
  if (!isRedisConfigured()) {
    return memoryHit(key, config);
  }
  try {
    return await redisHit(key, config);
  } catch (error) {
    logger.warn({ err: error, key }, "rate_limit.redis_failed.falling_back_to_memory");
    return memoryHit(key, config);
  }
}
