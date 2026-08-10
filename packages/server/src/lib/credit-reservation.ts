import { getRedis, isRedisConfigured } from "./redis";
import { logger } from "./logger";

// In-flight credit reservations.
//
// The credit gate reads a balance from Polar, but the matching debit is only
// ingested after the turn finishes streaming. That gap is a check-then-act
// race: the chat rate limit allows 30 requests/minute/user, so thirty turns
// can all read the same `balance = 1` and all start. Polar has no
// hold/authorize primitive, so we keep the pending total ourselves and
// subtract it from the balance the gate sees.
//
// Semantics are deliberately soft, matching lib/rate-limit and
// lib/free-grant-guard: this is a brake on concurrent overspend, not an
// accounting ledger. Polar's own balance remains the source of truth, and
// every path fails OPEN — a reservation-store outage must never block a
// paying user's turn.
const TTL_SECONDS = 15 * 60;

const key = (userId: string) => `credits:pending:${userId}`;

// Per-instance fallback when REDIS_URL is unset. Single instance only; a
// multi-replica deploy without Redis gets per-instance reservations, which is
// still a meaningful brake but not a global one. The server already logs a
// production warning when Redis is missing.
type Entry = { credits: number; expiresAt: number };
const memory = new Map<string, Entry>();

function sweepMemory(now: number) {
  if (memory.size < 10_000) return;
  for (const [k, v] of memory) if (v.expiresAt <= now) memory.delete(k);
}

function memoryPending(k: string): number {
  const entry = memory.get(k);
  if (!entry || entry.expiresAt <= Date.now()) return 0;
  return entry.credits;
}

function memoryAdd(k: string, credits: number): void {
  const now = Date.now();
  sweepMemory(now);
  const entry = memory.get(k);
  if (!entry || entry.expiresAt <= now) {
    memory.set(k, { credits, expiresAt: now + TTL_SECONDS * 1000 });
    return;
  }
  entry.credits += credits;
}

function memoryRelease(k: string, credits: number): void {
  const entry = memory.get(k);
  if (!entry) return;
  entry.credits -= credits;
  if (entry.credits <= 0) memory.delete(k);
}

/** Credits currently reserved by this user's in-flight turns. Fails open (0). */
export async function getPendingCredits(userId: string): Promise<number> {
  const k = key(userId);
  if (!isRedisConfigured()) return memoryPending(k);
  try {
    const redis = await getRedis();
    if (!redis) return memoryPending(k);
    const raw = await redis.get(k);
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (error) {
    logger.warn({ err: error, userId }, "credit_reservation.peek_failed.fail_open");
    return 0;
  }
}

/**
 * Reserve `credits` against this user for the duration of a turn. Always
 * succeeds — the caller decides whether to proceed by comparing the balance
 * against `getPendingCredits` first. Returns a release function that is safe
 * to call more than once.
 */
export async function reserveCredits(
  userId: string,
  credits: number,
): Promise<() => Promise<void>> {
  if (credits <= 0) return async () => {};

  const k = key(userId);
  let released = false;

  const releaseMemory = () => {
    if (released) return;
    released = true;
    memoryRelease(k, credits);
  };

  if (!isRedisConfigured()) {
    memoryAdd(k, credits);
    return async () => releaseMemory();
  }

  try {
    const redis = await getRedis();
    if (!redis) {
      memoryAdd(k, credits);
      return async () => releaseMemory();
    }

    // Refresh the TTL on every reservation so a steady stream of turns keeps
    // the key alive, and an abandoned one expires rather than leaking a
    // permanent phantom debit against the user.
    const tx = redis.multi();
    tx.incrBy(k, credits);
    tx.expire(k, TTL_SECONDS);
    await tx.exec();

    return async () => {
      if (released) return;
      released = true;
      try {
        const remaining = await redis.decrBy(k, credits);
        if (remaining <= 0) await redis.del(k);
      } catch (error) {
        // The TTL is the backstop: a lost release self-heals within 15
        // minutes rather than pinning the user's balance down forever.
        logger.warn({ err: error, userId }, "credit_reservation.release_failed");
      }
    };
  } catch (error) {
    logger.warn({ err: error, userId }, "credit_reservation.reserve_failed.fail_open");
    memoryAdd(k, credits);
    return async () => releaseMemory();
  }
}
