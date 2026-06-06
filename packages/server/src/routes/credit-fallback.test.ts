import { describe, expect, test } from "bun:test";
import {
  SUPPORTED_CHAT_MODELS,
  findSupportedChatModel,
  getModelByokProvider,
  getModelFallbackId,
  modelRequiresApiKey,
  type ByokProvider,
} from "@darkcode/shared";

// chat.ts gates hosted models on credits; when the balance hits zero it swaps
// to the model's registered `fallback` IF the user has that provider's BYOK
// key, otherwise it refuses with 402. This file characterizes that decision
// (chat.ts ~L171-203) over the real registry without booting the route (which
// imports env). `canFallbackOnDepletion` mirrors the route's inline predicate.

type Keys = Partial<Record<ByokProvider, string>>;

function canFallbackOnDepletion(model: string, apiKeys: Keys): boolean {
  const fallbackId = getModelFallbackId(model);
  const fallbackDef = fallbackId ? findSupportedChatModel(fallbackId) : undefined;
  if (!fallbackDef) return false;
  // A keyless fallback (hosted/ollama) is always usable; a BYOK fallback needs
  // the matching key to be present.
  if (!fallbackDef.requiresApiKey) return true;
  return apiKeys[fallbackDef.byokProvider] != null;
}

describe("credit-depleted fallback decision", () => {
  test("falls back to Haiku when the user has an Anthropic key", () => {
    expect(canFallbackOnDepletion("darkcode-ai", { anthropic: "sk-ant-x" })).toBe(true);
  });

  test("refuses (no fallback) when the user has no Anthropic key", () => {
    expect(canFallbackOnDepletion("darkcode-ai", {})).toBe(false);
  });

  test("refuses when the user only has an unrelated provider key", () => {
    expect(canFallbackOnDepletion("darkcode-ai", { openai: "sk-x" })).toBe(false);
  });

  test("a model with no registered fallback can never fall back", () => {
    expect(canFallbackOnDepletion("claude-haiku-4-5", { anthropic: "sk-ant-x" })).toBe(false);
  });
});

// chat.ts reads the Polar balance behind a try/catch: a confirmed balance is a
// number, but a transient fetch failure (Polar down / network) is mapped to
// `null` and the turn proceeds (fail open) rather than 503'ing — hard-blocking
// a paying user because the billing system glitched is the "you look broke"
// churn moment we refuse to create. Only a CONFIRMED non-positive balance
// gates. `gatesForDepletion` mirrors that inline predicate (chat.ts ~L255).
function gatesForDepletion(creditsBalance: number | null): boolean {
  return creditsBalance !== null && creditsBalance <= 0;
}

describe("credit gate fails open on an unreadable balance", () => {
  test("a confirmed zero balance gates the turn", () => {
    expect(gatesForDepletion(0)).toBe(true);
  });

  test("a confirmed negative balance gates the turn", () => {
    expect(gatesForDepletion(-5)).toBe(true);
  });

  test("a positive balance does not gate", () => {
    expect(gatesForDepletion(120)).toBe(false);
  });

  test("an unreadable balance (null) fails open — never gated as if broke", () => {
    expect(gatesForDepletion(null)).toBe(false);
  });
});

describe("hosted fallback wiring (the exact chain chat.ts walks)", () => {
  test("darkcode-ai falls back to claude-haiku-4-5", () => {
    expect(getModelFallbackId("darkcode-ai")).toBe("claude-haiku-4-5");
  });

  test("the hosted fallback is itself BYOK, so the fallback turn is never metered", () => {
    const fallback = findSupportedChatModel(getModelFallbackId("darkcode-ai") ?? "");
    expect(fallback?.requiresApiKey).toBe(true);
    // requiresApiKey narrows to the BYOK variants which carry byokProvider.
    expect(fallback && fallback.requiresApiKey && fallback.byokProvider).toBe("anthropic");
  });
});

describe("registry invariants the billing path relies on", () => {
  test("every declared fallback id resolves to a real model (no dangling)", () => {
    for (const m of SUPPORTED_CHAT_MODELS) {
      const fallbackId = getModelFallbackId(m.id);
      if (fallbackId !== null) {
        expect(findSupportedChatModel(fallbackId)).toBeDefined();
      }
    }
  });

  test("fallback chains terminate without cycles", () => {
    for (const m of SUPPORTED_CHAT_MODELS) {
      const seen = new Set<string>([m.id]);
      let current: string | null = getModelFallbackId(m.id);
      while (current !== null) {
        expect(seen.has(current)).toBe(false); // would be a cycle
        seen.add(current);
        current = getModelFallbackId(current);
      }
    }
  });

  test("modelRequiresApiKey and getModelByokProvider agree with each registry entry", () => {
    for (const m of SUPPORTED_CHAT_MODELS) {
      expect(modelRequiresApiKey(m.id)).toBe(m.requiresApiKey);
      if (m.requiresApiKey) {
        expect(getModelByokProvider(m.id)).toBe(m.byokProvider);
      } else {
        // Hosted (darkcode) and local (ollama) models have no BYOK slot.
        expect(getModelByokProvider(m.id)).toBeNull();
      }
    }
  });

  test("only the hosted darkcode provider is keyless-and-paid; ollama is keyless-and-free", () => {
    const keyless = SUPPORTED_CHAT_MODELS.filter((m) => !m.requiresApiKey);
    expect(keyless.map((m) => m.id).sort()).toEqual(["darkcode-ai", "ollama-default"]);
    const ollama = findSupportedChatModel("ollama-default");
    expect(ollama?.pricing).toEqual({
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    });
  });
});
