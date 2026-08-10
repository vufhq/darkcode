import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  findSupportedChatModel,
  type ByokProvider,
  type SupportedChatModel,
  type SupportedChatModelId,
  type SupportedProvider,
} from "@darkcode/shared";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";

type AnthropicModelId = Extract<SupportedChatModel, { provider: "anthropic" }>["id"];
type OpenAIModelId = Extract<SupportedChatModel, { provider: "openai" }>["id"];
type DarkcodeModelId = Extract<SupportedChatModel, { provider: "darkcode" }>["id"];
type OpenAICompatibleModel = Extract<SupportedChatModel, { provider: "openai-compatible" }>;
type GoogleModel = Extract<SupportedChatModel, { provider: "google" }>;
type OllamaModel = Extract<SupportedChatModel, { provider: "ollama" }>;

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

import { env } from "./env";

// Kimi K2.6 is rebranded Kimi served from Moonshot's OpenAI-compatible API.
// We pin the upstream model id here so callers only ever see the DarkCode label.
const DARKCODE_BACKING_MODEL: Record<DarkcodeModelId, string> = {
  "darkcode-ai": env.DARKCODE_BACKING_MODEL,
};

const MOONSHOT_BASE_URL = env.MOONSHOT_BASE_URL;

function assertUnsupportedProvider(provider: never): never {
  throw new Error(`Unsupported provider: ${provider}`);
}

// ── BYOK resolvers (user brings their own key) ─────────────────────────────

function resolveAnthropicModelByok(modelId: AnthropicModelId, apiKey: string): ResolvedModel {
  const anthropic = createAnthropic({ apiKey });
  return {
    model: anthropic(modelId),
    provider: "anthropic",
    modelId,
    providerOptions: ANTHROPIC_PROVIDER_OPTIONS[modelId],
    isMetered: false,
  };
}

function resolveOpenAIModelByok(modelId: OpenAIModelId, apiKey: string): ResolvedModel {
  const openai = createOpenAI({ apiKey });
  return {
    model: openai(modelId),
    provider: "openai",
    modelId,
    providerOptions: OPENAI_PROVIDER_OPTIONS[modelId],
    isMetered: false,
  };
}

function resolveOpenAICompatibleModelByok(
  model: OpenAICompatibleModel,
  apiKey: string,
): ResolvedModel {
  const provider = createOpenAI({
    apiKey,
    baseURL: model.baseUrl,
  });

  return {
    model: provider.chat(model.upstreamModelId),
    provider: "openai-compatible",
    modelId: model.id,
    isMetered: false,
  };
}

function resolveGoogleModelByok(model: GoogleModel, apiKey: string): ResolvedModel {
  const google = createGoogleGenerativeAI({ apiKey });
  return {
    model: google(model.upstreamModelId),
    provider: "google",
    modelId: model.id,
    isMetered: false,
  };
}

// ── Hosted resolvers (DarkCode proxies using our API keys) ─────────────────

function resolveAnthropicModelHosted(modelId: AnthropicModelId): ResolvedModel {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new HostedProviderNotConfiguredError("anthropic");
  }
  const anthropic = createAnthropic({ apiKey });
  return {
    model: anthropic(modelId),
    provider: "anthropic",
    modelId,
    providerOptions: ANTHROPIC_PROVIDER_OPTIONS[modelId],
    isMetered: true,
  };
}

function resolveOpenAIModelHosted(modelId: OpenAIModelId): ResolvedModel {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new HostedProviderNotConfiguredError("openai");
  }
  const openai = createOpenAI({ apiKey });
  return {
    model: openai(modelId),
    provider: "openai",
    modelId,
    providerOptions: OPENAI_PROVIDER_OPTIONS[modelId],
    isMetered: true,
  };
}

function resolveOpenAICompatibleModelHosted(model: OpenAICompatibleModel): ResolvedModel {
  // For openai-compatible providers, we use the same baseUrl but with our key.
  // Each provider needs its own env var for the hosted key.
  const apiKey = getHostedKeyForProvider(model.byokProvider);
  if (!apiKey) {
    throw new HostedProviderNotConfiguredError(model.byokProvider);
  }
  const provider = createOpenAI({
    apiKey,
    baseURL: model.baseUrl,
  });

  return {
    model: provider.chat(model.upstreamModelId),
    provider: "openai-compatible",
    modelId: model.id,
    isMetered: true,
  };
}

function resolveGoogleModelHosted(model: GoogleModel): ResolvedModel {
  const apiKey = env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new HostedProviderNotConfiguredError("google");
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return {
    model: google(model.upstreamModelId),
    provider: "google",
    modelId: model.id,
    isMetered: true,
  };
}

function resolveOllamaModel(model: OllamaModel): ResolvedModel {
  // Ollama exposes an OpenAI-compatible endpoint. No API key is needed.
  //
  // NOTE: this resolves and runs on the SERVER, like every other provider —
  // `OLLAMA_BASE_URL` is the server's view of the network, not the CLI user's.
  // On a hosted deployment that means the API server's own localhost, so this
  // model is only meaningful for self-hosted instances. The README says so.
  // It is also `isMetered: false`, so pointing this at a reachable endpoint on
  // a multi-tenant deployment hands out free inference — keep it unset there.
  const baseURL = env.OLLAMA_BASE_URL;
  // Allow the operator to point at a different pulled model at runtime.
  const upstreamModelId = env.OLLAMA_DEFAULT_MODEL ?? model.upstreamModelId;
  const ollama = createOpenAI({
    apiKey: "ollama", // Ollama ignores the key; the SDK requires a non-empty string.
    baseURL,
  });
  return {
    model: ollama.chat(upstreamModelId),
    provider: "ollama",
    modelId: model.id,
    isMetered: false,
  };
}

function resolveDarkcodeModel(modelId: DarkcodeModelId): ResolvedModel {
  const apiKey = env.MOONSHOT_API_KEY;

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

// ── Hosted key lookup ──────────────────────────────────────────────────────

function getHostedKeyForProvider(provider: ByokProvider): string | undefined {
  switch (provider) {
    case "anthropic":
      return env.ANTHROPIC_API_KEY;
    case "openai":
      return env.OPENAI_API_KEY;
    case "deepseek":
      return env.DEEPSEEK_API_KEY;
    case "google":
      return env.GOOGLE_API_KEY;
    case "ollama":
      return undefined; // Ollama never needs a key
    default:
      return undefined;
  }
}

// ── Resolution orchestration ───────────────────────────────────────────────

export type ProviderApiKeys = Partial<Record<ByokProvider, string>>;

function resolveSupportedChatModel(
  model: SupportedChatModel,
  apiKeys: ProviderApiKeys,
): ResolvedModel {
  const provider = model.provider;

  switch (provider) {
    case "darkcode":
      return resolveDarkcodeModel(model.id);

    case "anthropic": {
      // Prefer BYOK if the user provided a key, otherwise fall back to hosted.
      const byokKey = apiKeys.anthropic;
      if (byokKey) {
        return resolveAnthropicModelByok(model.id, byokKey);
      }
      if (model.canBeHosted) {
        return resolveAnthropicModelHosted(model.id);
      }
      throw new ApiKeyRequiredError("anthropic");
    }

    case "openai": {
      const byokKey = apiKeys.openai;
      if (byokKey) {
        return resolveOpenAIModelByok(model.id, byokKey);
      }
      if (model.canBeHosted) {
        return resolveOpenAIModelHosted(model.id);
      }
      throw new ApiKeyRequiredError("openai");
    }

    case "openai-compatible": {
      // Capture the discriminant before the `canBeHosted` check: every current
      // openai-compatible entry is hosted-capable (literal `true`), so TS
      // narrows the throw branch to `never` and would reject `model.byokProvider`.
      const byokProvider = model.byokProvider;
      const byokKey = apiKeys[byokProvider];
      if (byokKey) {
        return resolveOpenAICompatibleModelByok(model, byokKey);
      }
      if (model.canBeHosted) {
        return resolveOpenAICompatibleModelHosted(model);
      }
      throw new ApiKeyRequiredError(byokProvider);
    }

    case "google": {
      const byokKey = apiKeys.google;
      if (byokKey) {
        return resolveGoogleModelByok(model, byokKey);
      }
      if (model.canBeHosted) {
        return resolveGoogleModelHosted(model);
      }
      throw new ApiKeyRequiredError("google");
    }

    case "ollama":
      // Ollama is local-only and requires no key.
      return resolveOllamaModel(model);

    default:
      return assertUnsupportedProvider(provider);
  }
}

export class ApiKeyRequiredError extends Error {
  constructor(public readonly provider: ByokProvider) {
    super(`Missing API key for provider: ${provider}`);
    this.name = "ApiKeyRequiredError";
  }
}

export class HostedProviderNotConfiguredError extends Error {
  constructor(public readonly provider: ByokProvider) {
    super(`Hosted provider not configured: ${provider}. Add your own API key via /keys or contact support.`);
    this.name = "HostedProviderNotConfiguredError";
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
