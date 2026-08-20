// Mirror of packages/shared/src/models.ts.
//
// The server is the authority: it rejects an unknown `model` with 400, so this
// list only decides what the picker offers. Adding a model there means adding
// it here too.
#pragma once

#include <array>
#include <string_view>

namespace dc {

struct ModelInfo {
    std::string_view id;
    std::string_view displayName;
    std::string_view byokProvider; // empty when the model needs no key
    bool requiresApiKey;
    int contextWindow;
    std::string_view note;
};

inline constexpr std::array<ModelInfo, 13> kModels{{
    {"darkcode-ai", "Kimi K2.6", "", false, 128000, "Hosted default, billed as credits"},
    {"claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic", true, 200000, "Hosted on credits or BYOK"},
    {"claude-haiku-4-5", "Claude Haiku 4.5", "anthropic", true, 200000, "Hosted on credits or BYOK"},
    {"claude-opus-4-6", "Claude Opus 4.6", "anthropic", true, 200000, "Pro tier"},
    {"gpt-5.4", "GPT-5.4", "openai", true, 400000, "Hosted on credits or BYOK"},
    {"gpt-5.4-mini", "GPT-5.4 mini", "openai", true, 400000, "Hosted on credits or BYOK"},
    {"gpt-5.4-nano", "GPT-5.4 nano", "openai", true, 400000, "Hosted on credits or BYOK"},
    {"deepseek-chat", "DeepSeek V3", "deepseek", true, 65536, "Hosted on credits or BYOK"},
    {"deepseek-reasoner", "DeepSeek R1", "deepseek", true, 65536, "Hosted on credits or BYOK"},
    {"gemini-2.5-pro", "Gemini 2.5 Pro", "google", true, 1048576, "Hosted on credits or BYOK"},
    {"gemini-2.5-flash", "Gemini 2.5 Flash", "google", true, 1048576, "Hosted on credits or BYOK"},
    {"ollama-default", "Ollama (local)", "", false, 32768, "Self-hosted server only"},
    {"", "", "", false, 0, ""}, // sentinel, ignored by the picker
}};

/// BYOK providers and the header each key travels in (BYOK_PROVIDER_HEADER).
struct ByokProviderInfo {
    std::string_view id;
    std::string_view label;
    std::string_view header;
    std::string_view placeholder;
};

inline constexpr std::array<ByokProviderInfo, 4> kByokProviders{{
    {"anthropic", "Anthropic", "x-darkcode-anthropic-key", "sk-ant-..."},
    {"openai", "OpenAI", "x-darkcode-openai-key", "sk-..."},
    {"deepseek", "DeepSeek", "x-darkcode-deepseek-key", "sk-..."},
    {"google", "Google (Gemini)", "x-darkcode-google-key", "AIza..."},
}};

inline const ModelInfo* findModel(std::string_view id) {
    for (const auto& model : kModels) {
        if (!model.id.empty() && model.id == id) return &model;
    }
    return nullptr;
}

inline std::string_view modelDisplayName(std::string_view id) {
    const ModelInfo* model = findModel(id);
    return model ? model->displayName : id;
}

inline int modelContextWindow(std::string_view id) {
    const ModelInfo* model = findModel(id);
    return model ? model->contextWindow : 128000;
}

} // namespace dc
