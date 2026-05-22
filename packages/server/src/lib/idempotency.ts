import { getRedis, isRedisConfigured } from "./redis";
import { logger } from "./logger";

const TTL_SECONDS = 10 * 60;

// In-process fallback. Single instance only.
const memory = new Map<string, number>();

function memoryClaim(key: string): boolean {
  const now = Date.now();
  const expires = memory.get(key);
  if (expires && expires > now) return false;
  memory.set(key, now + TTL_SECONDS * 1000);
  // Trim opportunistically.
  if (memory.size > 10_000) {
    for (const [k, exp] of memory) {
      if (exp <= now) memory.delete(k);
    }
  }
  return true;
}

/**
 * Atomically claim an idempotency key for the given scope+user. Returns true
 * when this caller wins the claim and should proceed; false when the key was
 * already in flight or completed within the TTL window.
 */
export async function claimIdempotencyKey(scope: string, userId: string, key: string): Promise<boolean> {
  const composite = `idem:${scope}:${userId}:${key}`;
  if (!isRedisConfigured()) return memoryClaim(composite);

  try {
    const redis = await getRedis();
    if (!redis) return memoryClaim(composite);
    // NX = only set if absent. EX = TTL in seconds.
    const result = await redis.set(composite, "1", { NX: true, EX: TTL_SECONDS });
    return result === "OK";
  } catch (error) {
    logger.warn({ err: error, composite }, "idempotency.redis_failed.falling_back_to_memory");
    return memoryClaim(composite);
  }
}
