export type ModelPricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

// "darkcode" is our in-house provider, backed by Kimi (Moonshot) on the server.
// "anthropic" and "openai" use their native SDK adapters. "openai-compatible"
// covers any third-party provider that speaks the OpenAI chat-completions
// protocol (DeepSeek, OpenRouter, Groq, Together, vLLM, LM Studio, ...). New
// OpenAI-compatible providers are added by appending a model entry — no new
// adapter code required.
export type SupportedProvider =
  | "darkcode"
  | "anthropic"
  | "openai"
  | "openai-compatible";

// Identifies the slot a BYOK key is stored under, independent of which adapter
// the model uses. For native providers it matches the provider name; for
// openai-compatible models it names the upstream service.
export type ByokProvider = "anthropic" | "openai" | "deepseek";

export const BYOK_PROVIDERS: readonly ByokProvider[] = [
  "anthropic",
  "openai",
  "deepseek",
] as const;

export const BYOK_PROVIDER_LABELS: Record<ByokProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
};

export const BYOK_PROVIDER_HEADER: Record<ByokProvider, string> = {
  anthropic: "x-darkcode-anthropic-key",
  openai: "x-darkcode-openai-key",
  deepseek: "x-darkcode-deepseek-key",
};

export const BYOK_PROVIDER_KEY_PLACEHOLDER: Record<ByokProvider, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  deepseek: "sk-...",
};

type BaseModelDefinition = {
  id: string;
  displayName: string;
  pricing: ModelPricing;
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

type SupportedChatModelDefinition =
  | DarkcodeModelDefinition
  | AnthropicModelDefinition
  | OpenAIModelDefinition
  | OpenAICompatibleModelDefinition;

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
    byokProvider: "anthropic",
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
    byokProvider: "anthropic",
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
    byokProvider: "anthropic",
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
    byokProvider: "openai",
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
    byokProvider: "openai",
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
    byokProvider: "openai",
    pricing: {
      inputUsdPerMillionTokens: 0.2,
      outputUsdPerMillionTokens: 1.25,
    },
  },
  {
    id: "deepseek-chat",
    provider: "openai-compatible",
    displayName: "DeepSeek V3",
    requiresApiKey: true,
    byokProvider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    upstreamModelId: "deepseek-chat",
    pricing: {
      inputUsdPerMillionTokens: 0.27,
      outputUsdPerMillionTokens: 1.1,
    },
  },
  {
    id: "deepseek-reasoner",
    provider: "openai-compatible",
    displayName: "DeepSeek R1",
    requiresApiKey: true,
    byokProvider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    upstreamModelId: "deepseek-reasoner",
    pricing: {
      inputUsdPerMillionTokens: 0.55,
      outputUsdPerMillionTokens: 2.19,
    },
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

export const DEFAULT_CHAT_MODEL_ID: SupportedChatModelId = "darkcode-ai";
