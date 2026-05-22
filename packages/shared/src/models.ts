export type ModelPricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

// "darkcode" is our in-house provider, backed by Kimi (Moonshot) on the server.
// "anthropic" and "openai" are bring-your-own-key providers.
export type SupportedProvider = "darkcode" | "anthropic" | "openai";

type SupportedChatModelDefinition = {
  id: string;
  provider: SupportedProvider;
  displayName: string;
  // When true, the model requires a user-supplied API key (BYOK).
  // When false, the server uses its own credentials and the call is metered as credits.
  requiresApiKey: boolean;
  pricing: ModelPricing;
};

export const SUPPORTED_CHAT_MODELS = [
  {
    id: "darkcode-ai",
    provider: "darkcode",
    displayName: "DarkCode AI",
    requiresApiKey: false,
    // Pricing reflects what we pay upstream (Kimi K2). Resold as DarkCode credits.
    pricing: {
      inputUsdPerMillionTokens: 0.6,
      outputUsdPerMillionTokens: 2.5,
    },
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    displayName: "Claude Sonnet 4.6",
    requiresApiKey: true,
    pricing: {
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
    },
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    displayName: "Claude Haiku 4.5",
    requiresApiKey: true,
    pricing: {
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 5,
    },
  },
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    displayName: "Claude Opus 4.6",
    requiresApiKey: true,
    pricing: {
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 25,
    },
  },
  {
    id: "gpt-5.4",
    provider: "openai",
    displayName: "GPT-5.4",
    requiresApiKey: true,
    pricing: {
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 15,
    },
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    displayName: "GPT-5.4 mini",
    requiresApiKey: true,
    pricing: {
      inputUsdPerMillionTokens: 0.75,
      outputUsdPerMillionTokens: 4.5,
    },
  },
  {
    id: "gpt-5.4-nano",
    provider: "openai",
    displayName: "GPT-5.4 nano",
    requiresApiKey: true,
    pricing: {
      inputUsdPerMillionTokens: 0.2,
      outputUsdPerMillionTokens: 1.25,
    },
  },
] as const satisfies readonly SupportedChatModelDefinition[];

export type SupportedChatModel = (typeof SUPPORTED_CHAT_MODELS)[number];
export type SupportedChatModelId = SupportedChatModel["id"];

export type ByokProvider = Exclude<SupportedProvider, "darkcode">;

export function findSupportedChatModel(modelId: string) {
  return SUPPORTED_CHAT_MODELS.find((model) => model.id === modelId);
}

export function getModelDisplayName(modelId: string): string {
  return findSupportedChatModel(modelId)?.displayName ?? modelId;
}

export function modelRequiresApiKey(modelId: string): boolean {
  return findSupportedChatModel(modelId)?.requiresApiKey ?? false;
}

export const DEFAULT_CHAT_MODEL_ID: SupportedChatModelId = "darkcode-ai";
