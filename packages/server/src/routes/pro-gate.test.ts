import { describe, expect, test } from "bun:test";
import {
  SUPPORTED_CHAT_MODELS,
  findSupportedChatModel,
  isProTierModel,
} from "@darkcode/shared";

// chat.ts gates premium hosted models behind an active Pro subscription (Item 4).
// The gate lives inside the `resolvedModel.isMetered` branch and only fires when
// Pro is provisioned (POLAR_PRO_PRODUCT_ID set). This file characterizes that
// decision over the real registry without booting the route (which imports env).

type ProGateInput = {
  // Does this turn run on our infra? A BYOK turn resolves to the user's own
  // account (isMetered:false) and never reaches the gate.
  isMetered: boolean;
  // Is POLAR_PRO_PRODUCT_ID set for this environment? Unset => the gate is inert.
  proProvisioned: boolean;
  // Does the user hold an active Pro subscription? On a Polar error chat.ts fails
  // open (treats the user as Pro), which is modeled here by passing isPro:true.
  isPro: boolean;
};

// Mirrors chat.ts: a turn is refused with code "pro_required" iff it's a metered
// premium model, Pro is provisioned, and the user isn't Pro.
function refusedForPro(model: string, input: ProGateInput): boolean {
  if (!input.isMetered) return false; // BYOK turns are never tier-gated
  if (!input.proProvisioned) return false; // inert until provisioned
  if (!isProTierModel(model)) return false; // only premium models are gated
  return !input.isPro;
}

const PROVISIONED_NON_PRO: ProGateInput = {
  isMetered: true,
  proProvisioned: true,
  isPro: false,
};

describe("pro-tier gate decision", () => {
  test("a premium hosted model is refused for a non-Pro user once provisioned", () => {
    expect(refusedForPro("claude-opus-4-6", PROVISIONED_NON_PRO)).toBe(true);
    expect(refusedForPro("gpt-5.4", PROVISIONED_NON_PRO)).toBe(true);
    expect(refusedForPro("gemini-2.5-pro", PROVISIONED_NON_PRO)).toBe(true);
  });

  test("a Pro user is allowed the premium model", () => {
    expect(refusedForPro("claude-opus-4-6", { ...PROVISIONED_NON_PRO, isPro: true })).toBe(false);
  });

  test("the gate is inert until Pro is provisioned (current behavior preserved)", () => {
    expect(refusedForPro("claude-opus-4-6", { ...PROVISIONED_NON_PRO, proProvisioned: false })).toBe(false);
  });

  test("a premium model used via BYOK (unmetered) is never gated", () => {
    expect(refusedForPro("claude-opus-4-6", { ...PROVISIONED_NON_PRO, isMetered: false })).toBe(false);
  });

  test("a non-premium hosted model is never gated even for a non-Pro user", () => {
    expect(refusedForPro("darkcode-ai", PROVISIONED_NON_PRO)).toBe(false);
    expect(refusedForPro("claude-haiku-4-5", PROVISIONED_NON_PRO)).toBe(false);
    expect(refusedForPro("gemini-2.5-flash", PROVISIONED_NON_PRO)).toBe(false);
  });

  test("failing open (Polar error => treated as Pro) lets the turn through", () => {
    expect(refusedForPro("gpt-5.4", { ...PROVISIONED_NON_PRO, isPro: true })).toBe(false);
  });
});

describe("registry invariants the pro gate relies on", () => {
  test("isProTierModel matches exactly the premium models", () => {
    const proIds = SUPPORTED_CHAT_MODELS.filter((m) => isProTierModel(m.id))
      .map((m) => m.id)
      .sort();
    expect(proIds).toEqual(["claude-opus-4-6", "gemini-2.5-pro", "gpt-5.4"]);
  });

  test("the default hosted model is never a pro-tier model", () => {
    // darkcode-ai is the free/default model and must stay reachable without Pro.
    expect(isProTierModel("darkcode-ai")).toBe(false);
  });

  test("every pro-tier model is hostable (so it can actually be metered/gated)", () => {
    for (const m of SUPPORTED_CHAT_MODELS) {
      if (isProTierModel(m.id)) {
        expect(m.canBeHosted).toBe(true);
      }
    }
  });

  test("every pro-tier model requires an API key (so BYOK is always an escape hatch)", () => {
    // The chat.ts refusal always offers a BYOK alternative, and the CLI badge
    // logic prefers "BYOK" over "Pro" — both assume a byokProvider exists.
    for (const m of SUPPORTED_CHAT_MODELS) {
      if (isProTierModel(m.id)) {
        const def = findSupportedChatModel(m.id);
        expect(def?.requiresApiKey).toBe(true);
      }
    }
  });
});
