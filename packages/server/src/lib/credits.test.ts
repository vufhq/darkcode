import { describe, expect, test } from "bun:test";
import type { LanguageModelUsage } from "ai";

import {
  USD_PER_SEARCH,
  calculateCreditsForSearchRounds,
  calculateCreditsForUsage,
} from "./credits";

// "darkcode-ai" is the default hosted model. Its pricing (from the shared
// registry) is $0.60/M input, $2.50/M output. 1 credit = $0.01.
const HOSTED = { provider: "darkcode", model: "darkcode-ai" };

// calculateCreditsForUsage only reads inputTokens/outputTokens; the SDK's
// LanguageModelUsage carries extra detail fields we don't need, so we build a
// minimal object and cast once.
function usage(inputTokens?: number, outputTokens?: number): LanguageModelUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
  } as LanguageModelUsage;
}

describe("calculateCreditsForUsage — pricing math", () => {
  test("converts exactly one million in/out tokens at the registry price", () => {
    // 1M input * $0.60 + 1M output * $2.50 = $3.10 -> ceil($3.10 / $0.01) = 310.
    expect(calculateCreditsForUsage({ ...HOSTED, usage: usage(1_000_000, 1_000_000) })).toEqual({
      credits: 310,
    });
  });

  test("rounds a sub-credit cost up to a 1-credit floor", () => {
    // 1000 input tokens = $0.0006 -> 0.06 credits -> ceil -> 1.
    expect(calculateCreditsForUsage({ ...HOSTED, usage: usage(1000, 0) })).toEqual({
      credits: 1,
    });
  });

  test("always rounds partial credits up (never down)", () => {
    // 500k input ($0.30) + 500k output ($1.25) = $1.55 -> 155 credits exactly.
    expect(
      calculateCreditsForUsage({ ...HOSTED, usage: usage(500_000, 500_000) }).credits,
    ).toBe(155);
    // One extra output token tips it over 155.00 -> must round to 156.
    expect(
      calculateCreditsForUsage({ ...HOSTED, usage: usage(500_000, 500_001) }).credits,
    ).toBe(156);
  });

  test("charges zero credits for zero usage", () => {
    expect(calculateCreditsForUsage({ ...HOSTED, usage: usage(0, 0) })).toEqual({
      credits: 0,
    });
  });
});

describe("calculateCreditsForUsage — billing safety", () => {
  test("prices a hosted third-party model (now that DarkCode can host any model)", () => {
    // A model like claude-haiku-4-5 used to throw here as a BYOK guard. With
    // hosted credits for every model, the same model id can run either hosted
    // (metered) or BYOK (unmetered) — they're indistinguishable from pricing
    // alone. The "don't double-charge a BYOK user" guard therefore moved to
    // the call site: chat.ts only calls this when resolvedModel.isMetered is
    // true. Here we just verify the math: $1/M in + $5/M out over 1M each =
    // $6.00 -> 600 credits.
    expect(
      calculateCreditsForUsage({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: usage(1_000_000, 1_000_000),
      }),
    ).toEqual({ credits: 600 });
  });

  test("rejects a provider/model mismatch", () => {
    expect(() =>
      calculateCreditsForUsage({
        provider: "anthropic",
        model: "darkcode-ai",
        usage: usage(10, 10),
      }),
    ).toThrow(/Unsupported billing model/);
  });

  test("rejects an entirely unknown provider", () => {
    expect(() =>
      calculateCreditsForUsage({
        provider: "totally-made-up",
        model: "darkcode-ai",
        usage: usage(10, 10),
      }),
    ).toThrow(/Unsupported billing provider/);
  });
});

describe("calculateCreditsForUsage — cached input tokens", () => {
  // `cachedInputTokens` is a SUBSET of `inputTokens`, so the fresh count is the
  // difference. darkcode-ai: $0.60/M fresh, $0.15/M cached, $2.50/M output.
  function cachedUsage(
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number,
  ): LanguageModelUsage {
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens: inputTokens + outputTokens,
    } as LanguageModelUsage;
  }

  test("bills cache reads at the cached rate, not the fresh one", () => {
    // 1M input of which 800k cached: 200k fresh * $0.60 + 800k * $0.15
    // = $0.12 + $0.12 = $0.24 -> 24 credits.
    expect(
      calculateCreditsForUsage({ ...HOSTED, usage: cachedUsage(1_000_000, 0, 800_000) }).credits,
    ).toBe(24);
  });

  test("charges the full fresh rate when nothing is cached", () => {
    // Same total input, no cache: 1M * $0.60 = $0.60 -> 60 credits.
    expect(
      calculateCreditsForUsage({ ...HOSTED, usage: cachedUsage(1_000_000, 0, 0) }).credits,
    ).toBe(60);
  });

  test("a cache-heavy session costs materially less than the old flat math", () => {
    // This is the whole point of the split: the old code charged 60 credits
    // for the cache-heavy turn above. Guard the direction, not just the number.
    const cached = calculateCreditsForUsage({
      ...HOSTED,
      usage: cachedUsage(1_000_000, 0, 800_000),
    }).credits;
    const uncached = calculateCreditsForUsage({
      ...HOSTED,
      usage: cachedUsage(1_000_000, 0, 0),
    }).credits;
    expect(cached).toBeLessThan(uncached);
  });

  test("ignores a cached count that exceeds the input count", () => {
    // Clamped rather than producing a negative fresh count (and a credit).
    expect(
      calculateCreditsForUsage({ ...HOSTED, usage: cachedUsage(1000, 0, 999_999) }).credits,
    ).toBe(1);
  });

  test("falls back to the fresh rate when the provider omits the field", () => {
    // `usage()` builds an object with no cachedInputTokens at all.
    expect(calculateCreditsForUsage({ ...HOSTED, usage: usage(1_000_000, 0) }).credits).toBe(60);
  });
});

describe("calculateCreditsForUsage — malformed usage", () => {
  test("throws when a token count is missing", () => {
    expect(() => calculateCreditsForUsage({ ...HOSTED, usage: usage(undefined, 5) })).toThrow(
      /requires input and output token counts/,
    );
  });

  test("throws on a negative token count", () => {
    expect(() => calculateCreditsForUsage({ ...HOSTED, usage: usage(-1, 5) })).toThrow();
  });

  test("throws on a non-integer token count", () => {
    expect(() => calculateCreditsForUsage({ ...HOSTED, usage: usage(1.5, 5) })).toThrow();
  });

  test("throws on a non-finite token count", () => {
    expect(() =>
      calculateCreditsForUsage({ ...HOSTED, usage: usage(Number.POSITIVE_INFINITY, 5) }),
    ).toThrow();
    expect(() => calculateCreditsForUsage({ ...HOSTED, usage: usage(Number.NaN, 5) })).toThrow();
  });
});

describe("calculateCreditsForSearchRounds", () => {
  test("charges nothing for a turn that ran no searches", () => {
    expect(calculateCreditsForSearchRounds(0)).toBe(0);
  });

  test("charges one credit for a single search", () => {
    // $0.005 against a $0.01 credit rounds up to 1, the same way a tiny token
    // charge does. Rounding down would make the cheapest search free.
    expect(calculateCreditsForSearchRounds(1)).toBe(1);
  });

  test("two searches are exactly one credit", () => {
    expect(calculateCreditsForSearchRounds(2)).toBe(1);
  });

  test("rounds up on the half credit", () => {
    expect(calculateCreditsForSearchRounds(3)).toBe(2); // $0.015
    expect(calculateCreditsForSearchRounds(4)).toBe(2); // $0.020
  });

  test("prices the full per-turn budget at four credits", () => {
    // The default MOONSHOT_SEARCH_ROUNDS_PER_TURN is 8 → $0.04. This is the
    // most one turn can cost in search, and it is what bounds the unreserved
    // overrun (search is billed after the fact, not reserved up front).
    expect(calculateCreditsForSearchRounds(8)).toBe(4);
  });

  test("tracks the published Moonshot price", () => {
    // If this constant drifts from platform.kimi.ai/docs/pricing/tools, every
    // search is mispriced silently — so pin it.
    expect(USD_PER_SEARCH).toBe(0.005);
  });

  test("ignores nonsense input rather than throwing mid-turn", () => {
    // This runs in onFinish, after the response has already streamed; throwing
    // there loses the charge and logs an error for no benefit.
    expect(calculateCreditsForSearchRounds(-1)).toBe(0);
    expect(calculateCreditsForSearchRounds(Number.NaN)).toBe(0);
    expect(calculateCreditsForSearchRounds(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("floors a fractional round count", () => {
    expect(calculateCreditsForSearchRounds(2.9)).toBe(1);
  });
});
