import { Hono } from "hono";
import { db } from "@darkcode/database/client";
import { getRedis, isRedisConfigured } from "../lib/redis";

const startedAt = Date.now();

// Two endpoints with different semantics:
//   /healthz — liveness. Returns 200 as long as the process is up and the
//     event loop can respond. Kubernetes/Railway uses this to decide whether
//     to restart the container.
//   /readyz  — readiness. Returns 200 only when downstream dependencies
//     (DB, optionally Redis) respond. Used to decide whether to route
//     traffic. Failing readiness should NOT trigger a restart.
const app = new Hono()
  .get("/healthz", (c) => {
    return c.json({ ok: true, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });
  })
  .get("/readyz", async (c) => {
    const checks: Record<string, "ok" | "fail"> = {};
    let allOk = true;

    try {
      await db.$queryRaw`SELECT 1`;
      checks.db = "ok";
    } catch {
      checks.db = "fail";
      allOk = false;
    }

    if (isRedisConfigured()) {
      try {
        const redis = await getRedis();
        await redis?.ping();
        checks.redis = "ok";
      } catch {
        // Redis is non-critical — the rate limiter falls back to memory.
        // Report the failure but don't fail readiness.
        checks.redis = "fail";
      }
    }

    return c.json({ ok: allOk, checks }, allOk ? 200 : 503);
  });

export default app;
