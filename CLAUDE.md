# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

DarkCode is a terminal-based AI coding agent. A Bun-powered OpenTUI/React CLI talks to a Hono API that streams model output via the Vercel AI SDK, persists sessions in Postgres via Prisma, authenticates users through Clerk OAuth (PKCE browser flow), and meters AI usage as credits through Polar.

This repo is also a tutorial — branches `01-…` through `11-…` each represent a chapter; `main` is the final state. Avoid landing changes that only make sense at the end on earlier chapter branches.

## Common commands

Run from the repo root unless noted:

| Command | Purpose |
|---|---|
| `bun install` | Install workspace deps |
| `bun run dev:server` | Hono API on `http://localhost:3000`, hot reload |
| `bun run dev:cli` | CLI in watch mode (run in a second terminal — needs server up) |
| `bun run build:cli` | Build the CLI package |
| `bun run link:cli` | Build and `bun link` the `darkcode` executable globally |
| `bun run --cwd packages/database db:generate` | Regenerate the Prisma client (run after schema edits) |
| `bun run --cwd packages/database db:push` | Push the Prisma schema to the configured Postgres |

There is no test, lint, or typecheck script wired up — TypeScript runs in `noEmit` mode via the editor / Bun.

The server's `postinstall` automatically runs `db:generate` in `packages/database`.

## Architecture

Bun workspace with four packages in `packages/*`. Cross-package imports use the `@darkcode/*` workspace specifiers.

### `@darkcode/shared` — the contract between CLI and server

- `schemas.ts` defines `Mode` (`BUILD` | `PLAN`) and the AI SDK `tool()` contracts. `readOnlyToolContracts` (`readFile`, `listDirectory`, `glob`, `grep`) is exposed in PLAN mode; `buildToolContracts` adds `writeFile`, `editFile`, `bash` for BUILD. `getToolContracts(mode)` is the single source of truth — both server (for `streamText`) and CLI (for local execution dispatch) consume it.
- `models.ts` is the model registry: `SUPPORTED_CHAT_MODELS`, `DEFAULT_CHAT_MODEL_ID`, helpers (`findSupportedChatModel`, `modelRequiresApiKey`), and the `ByokProvider` / `ModelPricing` types. **Adding/changing a model goes here.**

### `@darkcode/server` — Hono API (`packages/server/src`)

- `index.ts` mounts `/auth`, `/billing`, `/sessions`, `/chat`. `requireAuth` middleware guards everything except `/auth` and the Polar webhook endpoints under `/billing`. `idleTimeout: 255` is intentionally high so long-running LLM tool calls don't get cut.
- `routes/chat.ts` is the heart of the system. It:
  1. Looks up the model in the shared registry; for hosted (non-BYOK) models it gates on Polar credits via `getAvailableCreditsBalance`.
  2. Loads the session, merges incoming messages with persisted history by `id`, validates with `validateUIMessages` against the tool contracts for the current mode.
  3. Calls `streamText` with `buildSystemPrompt({ mode, model })`, the resolved provider model, and the mode-appropriate tools.
  4. Streams back as `UIMessageStreamResponse` with metadata (`mode`, `model`, `durationMs`, `usage`).
  5. On finish: persists `event.messages` to `session.messages` (Json column) only when there are no pending tool calls, then ingests a Polar `darkcode_usage` event via `calculateCreditsForUsage` for metered models.
- `lib/models.ts` — `resolveChatModel(modelId, apiKeys)` returns the AI SDK model instance plus `providerOptions`, `isMetered`, and `provider`. BYOK keys arrive as `x-darkcode-anthropic-key` / `x-darkcode-openai-key` headers, read in `readApiKeysFromHeaders`. A missing key for a BYOK model throws `ApiKeyRequiredError`, which the route maps to a 400 telling the user to run `/keys`.
- `lib/polar.ts` + `lib/credits.ts` — credit math and Polar SDK calls. Event shape must stay exactly `{ name: "darkcode_usage", metadata: { credits } }` to match the meter filter set up in the Polar dashboard.
- `system-prompt.ts` builds the system prompt per `(mode, model)`.
- Error handling in `index.ts` re-surfaces `AI_APICallError` as 502 and other thrown errors with full message — tighten before public deployment.

### `@darkcode/database` — Prisma

Single `Session` model with `messages Json @default("[]")`. The chat route stores the entire `UIMessage[]` history in that column rather than normalizing per-message. Generated client lives at `packages/database/generated/prisma`; import via `@darkcode/database/client` (`db`) and `@darkcode/database` (types like `Prisma`).

### `@darkcode/cli` — OpenTUI + React terminal client (`packages/cli/src`)

- Entry `index.tsx` boots an OpenTUI CLI renderer (`exitOnCtrlC: false` — Ctrl+C is handled by dialogs) and mounts a memory router with routes `/`, `/sessions/new`, `/sessions/:id`.
- `lib/api-client.ts` calls the Hono server; it injects the auth token from `lib/auth.ts` and forwards BYOK API keys from `lib/api-keys.ts` as `x-darkcode-*` headers.
- `lib/oauth.ts` runs the PKCE flow: opens the browser to Clerk, runs a tiny localhost callback server, exchanges code for tokens via the server's `/auth/callback`.
- `lib/local-tools.ts` is the BUILD-mode execution layer. **All tool dispatch is client-side** — the server only declares the tool schema, the CLI executes the call against the user's actual filesystem inside `process.cwd()`. `resolveInsideCwd` rejects paths that escape the project dir; reads are capped at `MAX_FILE_SIZE`, search results at `MAX_RESULTS`/`MAX_MATCHES`, command output at `MAX_OUTPUT`, bash timeout defaults to 30s. PLAN-mode requests for write/edit/bash are rejected here as a defense-in-depth check.
- `lib/api-keys.ts` stores BYOK keys at `~/.darkcode/api-keys.json` — never sent to the DB, only forwarded as headers.
- UI is split into `screens/` (Home, NewSession, Session), `layouts/`, `components/` (dialogs, messages), `hooks/` (chat hook wraps `@ai-sdk/react`), `providers/` (Dialog, Keyboard, Prompt, Theme, Toast).

### Tool calling flow (end to end)

1. CLI sends user message + `{ mode, model }` to `POST /chat`.
2. Server gates credits → `streamText` with tools from `getToolContracts(mode)`.
3. Model emits a tool call as a stream part; AI SDK surfaces it to the CLI via `useChat`.
4. CLI's chat hook detects the tool call, runs `executeLocalTool(name, input, mode)` in `local-tools.ts`, posts the result back as a tool-output message.
5. Server resumes the stream with the tool output; on finish, persists `event.messages` and ingests Polar usage (hosted models only).

### Modes

- `PLAN` — read-only tools only, intended for exploration.
- `BUILD` — full tools incl. shell. The mode is carried in the request and re-stamped onto each message's metadata; switching mode mid-session is allowed and just changes which tools the next assistant turn can call.

### Models & billing

- "DarkCode AI" is the user-facing label for the hosted model backed by `MOONSHOT_API_KEY`. End users never see the upstream provider name.
- BYOK Anthropic/OpenAI models are NOT metered (`isMetered: false`) — `ingestAiUsage` is skipped.
- The Polar meter is keyed off the event `name` and the `credits` metadata field — do not rename either without updating the meter filter in the Polar dashboard.

## TypeScript

Strict mode, bundler resolution, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. Tests/lint aren't configured — when you touch types, rely on `tsc`/editor diagnostics.
