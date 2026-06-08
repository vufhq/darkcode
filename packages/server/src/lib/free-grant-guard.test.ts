import { describe, expect, mock, test } from "bun:test";

// free-grant-guard imports ./redis (which imports env, throwing without a full
// env) and ./logger. Mock both so the unit runs in isolation against the
// in-memory fallback path (isRedisConfigured: false). The dynamic import below
// MUST come after the mocks are registered.
mock.module("./redis", () => ({
  isRedisConfigured: () => false,
  getRedis: async () => null,
}));
mock.module("./logger", () => ({
  logger: { warn() {}, info() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

const { freeGrantIpLimitReached, recordFreeGrantForIp, FREE_GRANT_IP_CAP } =
  await import("./free-grant-guard");

// Unique IP per test so the module-level memory store never bleeds across tests
// (the window is 24h, so nothing expires mid-suite).
let n = 0;
const freshIp = () => `203.0.113.${n++}`;

describe("free-grant IP velocity guard (memory fallback)", () => {
  test("a fresh IP is under the cap", async () => {
    expect(await freeGrantIpLimitReached(freshIp())).toBe(false);
  });

  test("blocks only once the cap of recorded grants is reached", async () => {
    const ip = freshIp();
    for (let i = 0; i < FREE_GRANT_IP_CAP - 1; i++) {
      await recordFreeGrantForIp(ip);
      expect(await freeGrantIpLimitReached(ip)).toBe(false);
    }
    await recordFreeGrantForIp(ip); // hits the cap
    expect(await freeGrantIpLimitReached(ip)).toBe(true);
  });

  test("stays blocked past the cap", async () => {
    const ip = freshIp();
    for (let i = 0; i < FREE_GRANT_IP_CAP + 5; i++) await recordFreeGrantForIp(ip);
    expect(await freeGrantIpLimitReached(ip)).toBe(true);
  });

  test("counts are per-IP — one IP at the cap doesn't block another", async () => {
    const hot = freshIp();
    const cold = freshIp();
    for (let i = 0; i < FREE_GRANT_IP_CAP; i++) await recordFreeGrantForIp(hot);
    expect(await freeGrantIpLimitReached(hot)).toBe(true);
    expect(await freeGrantIpLimitReached(cold)).toBe(false);
  });

  test("peeking never increments — returning users that only re-check stay unblocked", async () => {
    // A returning user's no-op grant re-check calls freeGrantIpLimitReached but
    // never recordFreeGrantForIp; that path must not consume budget.
    const ip = freshIp();
    for (let i = 0; i < FREE_GRANT_IP_CAP * 5; i++) {
      expect(await freeGrantIpLimitReached(ip)).toBe(false);
    }
  });
});
