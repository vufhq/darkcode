import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  findSupportedChatModel,
  type SupportedChatModel,
  type SupportedChatModelId,
  type SupportedProvider,
} from "@darkcode/shared";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";

type AnthropicModelId = Extract<SupportedChatModel, { provider: "anthropic" }>["id"];
type OpenAIModelId = Extract<SupportedChatModel, { provider: "openai" }>["id"];
type DarkcodeModelId = Extract<SupportedChatModel, { provider: "darkcode" }>["id"];

export type ResolvedModel = {
  model: LanguageModel;
  provider: SupportedProvider;
  modelId: SupportedChatModelId;
  providerOptions?: ProviderOptions;
  // True when this model is metered against DarkCode credits on our infra,
  // false when the user supplied their own key for a third-party provider.
  isMetered: boolean;
};

const ANTHROPIC_PROVIDER_OPTIONS: Partial<Record<AnthropicModelId, ProviderOptions>> = {
  "claude-opus-4-6": {
    anthropic: {
      thinking: {
        type: "enabled",
        budgetTokens: 10000,
      },
    },
  },
  "claude-sonnet-4-6": {
    anthropic: {
      thinking: {
        type: "enabled",
        budgetTokens: 10000,
      },
    },
  },
};

const OPENAI_PROVIDER_OPTIONS: Partial<Record<OpenAIModelId, ProviderOptions>> = {
  "gpt-5.4": {
    openai: {
      thinking: {
        reasoningSummary: "detailed",
      },
    },
  },
};

// DarkCode AI is rebranded Kimi served from Moonshot's OpenAI-compatible API.
// We pin the upstream model id here so callers only ever see the DarkCode label.
// kimi-k2.6 is the current production model — override via DARKCODE_BACKING_MODEL
// if you want to point at a different Kimi version.
const DARKCODE_BACKING_MODEL: Record<DarkcodeModelId, string> = {
  "darkcode-ai": process.env.DARKCODE_BACKING_MODEL ?? "kimi-k2.6",
};

const MOONSHOT_BASE_URL = process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1";

function assertUnsupportedProvider(provider: never): never {
  throw new Error(`Unsupported provider: ${provider}`);
}

function resolveAnthropicModel(modelId: AnthropicModelId, apiKey: string): ResolvedModel {
  const anthropic = createAnthropic({ apiKey });
  return {
    model: anthropic(modelId),
    provider: "anthropic",
    modelId,
    providerOptions: ANTHROPIC_PROVIDER_OPTIONS[modelId],
    isMetered: false,
  };
}

function resolveOpenAIModel(modelId: OpenAIModelId, apiKey: string): ResolvedModel {
  const openai = createOpenAI({ apiKey });
  return {
    model: openai(modelId),
    provider: "openai",
    modelId,
    providerOptions: OPENAI_PROVIDER_OPTIONS[modelId],
    isMetered: false,
  };
}

function resolveDarkcodeModel(modelId: DarkcodeModelId): ResolvedModel {
  const apiKey = process.env.MOONSHOT_API_KEY;
  if (!apiKey) {
    throw new Error("MOONSHOT_API_KEY is not configured on the server");
  }

  // Kimi K2.6 has thinking enabled by default. The AI SDK doesn't preserve
  // the model's reasoning_content across turns, so the next request fails with
  // "thinking is enabled but reasoning_content is missing in assistant tool
  // call message". We disable thinking via a fetch interceptor that injects
  // `thinking: { type: "disabled" }` into the chat-completions body. The
  // OpenAI provider strips unknown fields from `providerOptions`, so we have
  // to do this at the HTTP layer.
  const moonshotFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (init?.body && typeof init.body === "string" && url.includes("/chat/completions")) {
      try {
        const parsed = JSON.parse(init.body);
        parsed.thinking = { type: "disabled" };
        return fetch(input, { ...init, body: JSON.stringify(parsed) });
      } catch {
        // If body isn't JSON, fall through to the original request.
      }
    }

    return fetch(input, init);
  };

  const moonshot = createOpenAI({
    apiKey,
    baseURL: MOONSHOT_BASE_URL,
    // The AI SDK types `fetch` as the global `fetch` which under @types/bun
    // includes a `preconnect` field. Our interceptor is a plain function so
    // we cast through unknown to satisfy both typings.
    fetch: moonshotFetch as unknown as typeof fetch,
  });

  return {
    model: moonshot.chat(DARKCODE_BACKING_MODEL[modelId]),
    provider: "darkcode",
    modelId,
    isMetered: true,
  };
}

export type ProviderApiKeys = {
  anthropic?: string;
  openai?: string;
};

function resolveSupportedChatModel(
  model: SupportedChatModel,
  apiKeys: ProviderApiKeys,
): ResolvedModel {
  const provider = model.provider;

  switch (provider) {
    case "darkcode":
      return resolveDarkcodeModel(model.id);
    case "anthropic": {
      const apiKey = apiKeys.anthropic;
      if (!apiKey) {
        throw new ApiKeyRequiredError("anthropic");
      }
      return resolveAnthropicModel(model.id, apiKey);
    }
    case "openai": {
      const apiKey = apiKeys.openai;
      if (!apiKey) {
        throw new ApiKeyRequiredError("openai");
      }
      return resolveOpenAIModel(model.id, apiKey);
    }
    default:
      return assertUnsupportedProvider(provider);
  }
}

export class ApiKeyRequiredError extends Error {
  constructor(public readonly provider: SupportedProvider) {
    super(`Missing API key for provider: ${provider}`);
    this.name = "ApiKeyRequiredError";
  }
}

export function isSupportedChatModel(modelId: string): modelId is SupportedChatModelId {
  return findSupportedChatModel(modelId) != null;
}

export function resolveChatModel(modelId: string, apiKeys: ProviderApiKeys = {}): ResolvedModel {
  const model = findSupportedChatModel(modelId);
  if (!model) {
    throw new Error(`Unsupported model: ${modelId}`);
  }

  return resolveSupportedChatModel(model, apiKeys);
}
