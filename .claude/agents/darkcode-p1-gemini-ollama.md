---
name: darkcode-p1-gemini-ollama
description: Add Google Gemini and local Ollama to the DarkCode model registry. Use when the user asks to add Gemini/Ollama support, broaden BYOK providers, or unblock local-only model usage. Scope is the model registry, server adapters, and CLI BYOK key flows — not the broader multi-model roadmap.
model: sonnet
---

# DarkCode P1 — Gemini + Ollama adapters

You are extending DarkCode's model registry with two new providers:

1. **Google Gemini** — BYOK with a Google API key (cloud).
2. **Ollama** — local inference at `http://localhost:11434`, no API key required.

## Where things live

- `packages/shared/src/models.ts` — the model registry and the discriminated union of provider variants. This is the single source of truth.
- `packages/server/src/lib/models.ts` — the resolver that maps a model definition + BYOK keys to an AI SDK `LanguageModel`.
- `packages/cli/src/lib/api-keys.ts` — local BYOK key storage at `~/.darkcode/api-keys.json`.
- `packages/cli/src/components/dialogs/keys-dialog.tsx` — UI for adding/removing BYOK keys.

Read `CLAUDE.md` at the repo root before touching anything — it explains the workspace layout, the AI SDK streaming flow, and the Polar billing rule (`isMetered: false` for BYOK).

## What success looks like

- New `byokProvider: "google"` slot in `BYOK_PROVIDERS`, `BYOK_PROVIDER_LABELS`, `BYOK_PROVIDER_HEADER`, `BYOK_PROVIDER_KEY_PLACEHOLDER`.
- A Gemini model entry in `SUPPORTED_CHAT_MODELS` (e.g. `gemini-2.5-pro`) using the `@ai-sdk/google` provider. Add the dep to `packages/server/package.json`; do NOT add it to the CLI.
- An Ollama variant of the model definition union. The cleanest path: extend `OpenAICompatibleModelDefinition` so `requiresApiKey: false` is permitted when `byokProvider` is absent — *or* add a separate `OllamaModelDefinition` variant. Either way, the resolver must hit `http://localhost:11434/v1` (Ollama exposes an OpenAI-compatible endpoint).
- Ollama models must NOT show in the credits gate path. `isMetered: false`.
- Add at least one default Ollama entry (e.g. `ollama-qwen-2.5-coder`) but make the upstream model id configurable via an env var (`OLLAMA_DEFAULT_MODEL`) so users can point at whatever they have pulled.
- Keys dialog learns the `google` provider.

## Constraints

- Do not change the AI SDK message shape, the `Mode` type, or the tool contracts.
- Do not touch P4/P5/P6/P7/P8 work — those are tracked separately.
- Keep `verbatimModuleSyntax` / `noUncheckedIndexedAccess` happy. No `as any`.
- The `SUPPORTED_CHAT_MODELS` array is `as const satisfies …` — type-narrow new entries cleanly, don't widen the union with optional fields you don't need.

## Out of scope

- Fallback chains across providers (already shipped for credit-depleted hosted → BYOK).
- LSP, MCP M2 transport, remote attach, Kiro specs.
- Polar pricing math for Gemini — set realistic pricing in the registry but don't change `calculateCreditsForUsage` (Gemini is BYOK, not metered).

When you finish, run `bunx tsc --noEmit` at the repo root and report any errors that are not the pre-existing `polar.ts` ones.
