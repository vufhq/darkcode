import { getRedis, isRedisConfigured } from "./redis";
import { logger } from "./logger";

// Soft per-IP velocity cap on NEW free-tier grants (Item 3 / Tier 3 abuse
// guard). Hosted credits cost us upstream money, so the abuse vector is scripted
// multi-signup farming — many Clerk identities from one IP, each claiming the
// free grant. This caps how many grants a single IP can trigger within a rolling
// window.
//
// Deliberately lenient: the free allowance is small (~75 cr ≈ $0.75), so the
// per-account abuse ceiling is low and over-blocking legitimate users behind a
// shared NAT/CGNAT is the worse failure (MONETIZATION.md Tier 3 — "don't
// over-build the guard"). Two properties keep false positives down:
//   - only ACTUAL new grants are counted (callers record on "granted"), so a
//     shared IP's legitimate returning users — whose grant is a no-op re-check —
//     never consume budget; and
//   - it FAILS OPEN: a counter-store hiccup never blocks a signup grant.
const MAX_NEW_GRANTS_PER_IP = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;

const key = (ip: string) => `freegrant:ip:${ip}`;

// In-process fallback. Single instance only; multi-instance deploys MUST set
// REDIS_URL, otherwise each instance keeps its own count (the cap then applies
// per instance — still a meaningful brake, just looser). Mirrors lib/rate-limit.
type Bucket = { count: number; resetAt: number };
const memory = new Map<string, Bucket>();

function memoryCount(k: string): number {
  const b = memory.get(k);
  if (!b || b.resetAt <= Date.now()) return 0;
  return b.count;
}

function memoryRecord(k: string): void {
  const now = Date.now();
  const b = memory.get(k);
  if (!b || b.resetAt <= now) {
    memory.set(k, { count: 1, resetAt: now + WINDOW_MS });
    // Opportunistic trim so a flood of unique IPs can't grow unbounded.
    if (memory.size > 10_000) {
      for (const [mk, mb] of memory) if (mb.resetAt <= now) memory.delete(mk);
    }
    return;
  }
  b.count += 1;
}

// Has this IP already hit the new-grant cap in the current window? Checked
// BEFORE issuing a grant. Fails OPEN (returns false) when the store is
// unavailable — we never refuse a signup grant because the counter backend
// hiccuped.
export async function freeGrantIpLimitReached(ip: string): Promise<boolean> {
  const k = key(ip);
  if (!isRedisConfigured()) return memoryCount(k) >= MAX_NEW_GRANTS_PER_IP;
  try {
    const redis = await getRedis();
    if (!redis) return memoryCount(k) >= MAX_NEW_GRANTS_PER_IP;
    const raw = await redis.get(k);
    return (raw ? Number(raw) : 0) >= MAX_NEW_GRANTS_PER_IP;
  } catch (error) {
    logger.warn({ err: error, ip }, "free_grant_guard.peek_failed.fail_open");
    return false;
  }
}

// Record that a NEW grant was just issued from this IP. Best-effort: a failure
// only under-counts, which is the safe direction for a soft guard. Call this
// ONLY when a grant actually landed ("granted"), never on a no-op re-check, so
// returning users don't consume their IP's budget.
export async function recordFreeGrantForIp(ip: string): Promise<void> {
  const k = key(ip);
  if (!isRedisConfigured()) {
    memoryRecord(k);
    return;
  }
  try {
    const redis = await getRedis();
    if (!redis) {
      memoryRecord(k);
      return;
    }
    // INCR + read TTL atomically; set the window TTL only when the key is new
    // (no TTL yet), so the window is fixed from the first grant. Mirrors
    // lib/rate-limit's redisHit.
    const tx = redis.multi();
    tx.incr(k);
    tx.pTTL(k);
    const [, ttlRaw] = (await tx.exec()) as unknown as [number, number];
    if (Number(ttlRaw) < 0) await redis.pExpire(k, WINDOW_MS);
  } catch (error) {
    logger.warn({ err: error, ip }, "free_grant_guard.record_failed");
    memoryRecord(k);
  }
}

// Exposed for tests / observability.
export const FREE_GRANT_IP_CAP = MAX_NEW_GRANTS_PER_IP;
