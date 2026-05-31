import { describe, expect, test } from "bun:test";
import type { LanguageModelUsage } from "ai";

import { calculateCreditsForUsage } from "./credits";

// The hosted "darkcode-ai" model is the only metered model. Its pricing
// (from the shared registry) is $0.60/M input, $2.50/M output. 1 credit = $0.01.
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
  test("refuses to bill a BYOK model (they bill against the user's own account)", () => {
    // This is the guard that stops us double-charging a user who brought their
    // own Anthropic key. It must throw, not silently meter.
    expect(() =>
      calculateCreditsForUsage({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: usage(1_000_000, 1_000_000),
      }),
    ).toThrow(/BYOK and is not billed/);
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
