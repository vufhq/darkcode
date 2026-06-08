export type ModelPricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

// "darkcode" is our in-house provider, backed by Kimi (Moonshot) on the server.
// "anthropic" and "openai" use their native SDK adapters. "openai-compatible"
// covers any third-party provider that speaks the OpenAI chat-completions
// protocol (DeepSeek, OpenRouter, Groq, Together, vLLM, LM Studio, ...). New
// OpenAI-compatible providers are added by appending a model entry — no new
// adapter code required. "google" uses the @ai-sdk/google adapter; "ollama"
// uses Ollama's OpenAI-compatible local endpoint at http://localhost:11434/v1.
export type SupportedProvider =
  | "darkcode"
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "google"
  | "ollama";

// Identifies the slot a BYOK key is stored under, independent of which adapter
// the model uses. For native providers it matches the provider name; for
// openai-compatible models it names the upstream service.
// "ollama" has no key — it's included so the type system can reference it
// uniformly, but the key is never required or stored.
export type ByokProvider = "anthropic" | "openai" | "deepseek" | "google" | "ollama";

export const BYOK_PROVIDERS: readonly ByokProvider[] = [
  "anthropic",
  "openai",
  "deepseek",
  "google",
  "ollama",
] as const;

export const BYOK_PROVIDER_LABELS: Record<ByokProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  google: "Google (Gemini)",
  ollama: "Ollama (local)",
};

export const BYOK_PROVIDER_HEADER: Record<ByokProvider, string> = {
  anthropic: "x-darkcode-anthropic-key",
  openai: "x-darkcode-openai-key",
  deepseek: "x-darkcode-deepseek-key",
  google: "x-darkcode-google-key",
  ollama: "x-darkcode-ollama-key",
};

export const BYOK_PROVIDER_KEY_PLACEHOLDER: Record<ByokProvider, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  deepseek: "sk-...",
  google: "AIza...",
  ollama: "(no key required — Ollama runs locally)",
};

type BaseModelDefinition = {
  id: string;
  displayName: string;
  pricing: ModelPricing;
  // Maximum input tokens the model accepts. Used by the server's compaction
  // trigger; not a hard cap on output. Values reflect the upstream provider's
  // published window for the chat endpoint, not extended-context tiers.
  contextWindow: number;
  // Optional fallback model id consulted by the chat route when the primary
  // upstream call fails with an AI_APICallError (rate limit, transient 5xx).
  // The fallback inherits the user's BYOK keys — if the fallback also
  // requires a key the user doesn't have, the original error surfaces.
  fallback?: string;
  // When true, DarkCode can host this model on its own infrastructure (using
  // our API keys) and bill the user in credits. When false, the model can
  // only be used via BYOK or is free (e.g. Ollama).
  canBeHosted: boolean;
  // Access tier for *hosted* (metered) use. Absent = available to everyone on
  // credits / the free tier. "pro" = the premium hosted models, gated behind an
  // active Pro subscription when run on our infra. BYOK is never gated by tier
  // (the user's own key always works), and the gate is inert until Pro is
  // provisioned server-side (POLAR_PRO_PRODUCT_ID). See `isProTierModel`.
  tier?: "pro";
};

type DarkcodeModelDefinition = BaseModelDefinition & {
  provider: "darkcode";
  requiresApiKey: false;
};

type AnthropicModelDefinition = BaseModelDefinition & {
  provider: "anthropic";
  requiresApiKey: true;
  byokProvider: "anthropic";
};

type OpenAIModelDefinition = BaseModelDefinition & {
  provider: "openai";
  requiresApiKey: true;
  byokProvider: "openai";
};

type OpenAICompatibleModelDefinition = BaseModelDefinition & {
  provider: "openai-compatible";
  requiresApiKey: true;
  byokProvider: ByokProvider;
  // Upstream API base URL (must point at the /v1 root, no trailing slash).
  baseUrl: string;
  // The exact model id to send to the upstream provider — may differ from `id`.
  upstreamModelId: string;
};

// Google Gemini via @ai-sdk/google. Requires a Google API key (BYOK).
type GoogleModelDefinition = BaseModelDefinition & {
  provider: "google";
  requiresApiKey: true;
  byokProvider: "google";
  // The exact Gemini model id passed to the Google provider (e.g. "gemini-2.5-pro").
  upstreamModelId: string;
};

// Ollama runs locally and never needs an API key. The base URL can be
// overridden via the OLLAMA_BASE_URL env var; it defaults to
// http://localhost:11434/v1 (Ollama's OpenAI-compatible endpoint).
// The actual model pulled in Ollama is controlled by OLLAMA_DEFAULT_MODEL.
type OllamaModelDefinition = BaseModelDefinition & {
  provider: "ollama";
  requiresApiKey: false;
  // The model id to request from Ollama. Can be overridden at runtime via
  // OLLAMA_DEFAULT_MODEL env var.
  upstreamModelId: string;
};

type SupportedChatModelDefinition =
  | DarkcodeModelDefinition
  | AnthropicModelDefinition
  | OpenAIModelDefinition
  | OpenAICompatibleModelDefinition
  | GoogleModelDefinition
  | OllamaModelDefinition;

export const SUPPORTED_CHAT_MODELS = [
  {
    id: "darkcode-ai",
    provider: "darkcode",
    displayName: "Kimi K2.6",
    requiresApiKey: false,
    canBeHosted: true,
    // Pricing reflects what we pay upstream (Kimi K2). Resold as DarkCode credits.
    pricing: {
      inputUsdPerMillionTokens: 0.6,
      outputUsdPerMillionTokens: 2.5,
    },
    contextWindow: 128_000,
    // When credits are depleted, prefer the user's own Claude Haiku key
    // before failing. Falls through if no anthropic key is configured.
    fallback: "claude-haiku-4-5",
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    displayName: "Claude Sonnet 4.6",
    requiresApiKey: true,
    canBeHosted: true,
    byokProvider: "anthropic",
    pricing: {
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
    },
    contextWindow: 200_000,
    fallback: "claude-haiku-4-5",
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    displayName: "Claude Haiku 4.5",
    requiresApiKey: true,
    canBeHosted: true,
    byokProvider: "anthropic",
    pricing: {
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 5,
    },
    contextWindow: 200_000,
  },
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    displayName: "Claude Opus 4.6",
    requiresApiKey: true,
    canBeHosted: true,
    tier: "pro",
    byokProvider: "anthropic",
    pricing: {
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 25,
    },
    contextWindow: 200_000,
    fallback: "claude-sonnet-4-6",
  },
  {
    id: "gpt-5.4",
    provider: "openai",
    displayName: "GPT-5.4",
    requiresApiKey: true,
    canBeHosted: true,
    tier: "pro",
    byokProvider: "openai",
    pricing: {
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 15,
    },
    contextWindow: 400_000,
    fallback: "gpt-5.4-mini",
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    displayName: "GPT-5.4 mini",
    requiresApiKey: true,
    canBeHosted: true,
    byokProvider: "openai",
    pricing: {
      inputUsdPerMillionTokens: 0.75,
      outputUsdPerMillionTokens: 4.5,
    },
    contextWindow: 400_000,
  },
  {
    id: "gpt-5.4-nano",
    provider: "openai",
    displayName: "GPT-5.4 nano",
    requiresApiKey: true,
    canBeHosted: true,
    byokProvider: "openai",
    pricing: {
      inputUsdPerMillionTokens: 0.2,
      outputUsdPerMillionTokens: 1.25,
    },
    contextWindow: 400_000,
  },
  {
    id: "deepseek-chat",
    provider: "openai-compatible",
    displayName: "DeepSeek V3",
    requiresApiKey: true,
    canBeHosted: true,
    byokProvider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    upstreamModelId: "deepseek-chat",
    pricing: {
      inputUsdPerMillionTokens: 0.27,
      outputUsdPerMillionTokens: 1.1,
    },
    contextWindow: 65_536,
  },
  {
    id: "deepseek-reasoner",
    provider: "openai-compatible",
    displayName: "DeepSeek R1",
    requiresApiKey: true,
    canBeHosted: true,
    byokProvider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    upstreamModelId: "deepseek-reasoner",
    pricing: {
      inputUsdPerMillionTokens: 0.55,
      outputUsdPerMillionTokens: 2.19,
    },
    contextWindow: 65_536,
  },
  // ── Google Gemini (BYOK via Google AI Studio key) ──────────────────────────
  {
    id: "gemini-2.5-pro",
    provider: "google",
    displayName: "Gemini 2.5 Pro",
    requiresApiKey: true,
    canBeHosted: true,
    tier: "pro",
    byokProvider: "google",
    upstreamModelId: "gemini-2.5-pro",
    pricing: {
      // Google AI pricing as of 2025 (prompts >200k tokens billed at 2x).
      inputUsdPerMillionTokens: 1.25,
      outputUsdPerMillionTokens: 10,
    },
    contextWindow: 1_048_576,
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    displayName: "Gemini 2.5 Flash",
    requiresApiKey: true,
    canBeHosted: true,
    byokProvider: "google",
    upstreamModelId: "gemini-2.5-flash",
    pricing: {
      inputUsdPerMillionTokens: 0.15,
      outputUsdPerMillionTokens: 0.6,
    },
    contextWindow: 1_048_576,
    fallback: "gemini-2.5-pro",
  },
  // ── Ollama (local, no API key required) ────────────────────────────────────
  // The upstream model id defaults to "qwen2.5-coder:7b" but can be overridden
  // at runtime via the OLLAMA_DEFAULT_MODEL env var on the server.
  {
    id: "ollama-default",
    provider: "ollama",
    displayName: "Ollama (local)",
    requiresApiKey: false,
    canBeHosted: false,
    upstreamModelId: "qwen2.5-coder:7b",
    pricing: {
      // Local inference — no token cost.
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    },
    contextWindow: 32_768,
  },
] as const satisfies readonly SupportedChatModelDefinition[];

export type SupportedChatModel = (typeof SUPPORTED_CHAT_MODELS)[number];
export type SupportedChatModelId = SupportedChatModel["id"];

export function findSupportedChatModel(modelId: string) {
  return SUPPORTED_CHAT_MODELS.find((model) => model.id === modelId);
}

export function getModelDisplayName(modelId: string): string {
  return findSupportedChatModel(modelId)?.displayName ?? modelId;
}

export function modelRequiresApiKey(modelId: string): boolean {
  return findSupportedChatModel(modelId)?.requiresApiKey ?? false;
}

export function getModelByokProvider(modelId: string): ByokProvider | null {
  const model = findSupportedChatModel(modelId);
  if (!model || !model.requiresApiKey) return null;
  return model.byokProvider;
}

export function modelCanBeHosted(modelId: string): boolean {
  return findSupportedChatModel(modelId)?.canBeHosted ?? false;
}

export const DEFAULT_CHAT_MODEL_ID: SupportedChatModelId = "darkcode-ai";

export function getModelContextWindow(modelId: string): number {
  return findSupportedChatModel(modelId)?.contextWindow ?? 128_000;
}

export function getModelFallbackId(modelId: string): string | null {
  const m = findSupportedChatModel(modelId);
  return m && "fallback" in m && typeof m.fallback === "string" ? m.fallback : null;
}

// A premium hosted model that, when run on DarkCode's infra (metered), requires
// an active Pro subscription. `tier` only exists on the entries that carry it
// (the registry is `as const`), so probe with `"tier" in m` — same pattern as
// `getModelFallbackId`. BYOK use is never gated by this; see chat.ts.
export function isProTierModel(modelId: string): boolean {
  const m = findSupportedChatModel(modelId);
  return m != null && "tier" in m && m.tier === "pro";
}
