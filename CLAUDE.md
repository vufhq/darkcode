# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

DarkCode is a terminal-based AI coding agent. A Bun-powered OpenTUI/React CLI talks to a Hono API that streams model output via the Vercel AI SDK, persists sessions in Postgres via Prisma, authenticates users through Clerk OAuth (PKCE browser flow), and meters AI usage as credits through Polar.

It started as a tutorial repo, but `master` now carries a larger feature build-out layered on the base: **multi-model BYOK** (Anthropic/OpenAI/DeepSeek/Google/Ollama), a **client-side permission engine**, **server-side context compaction**, a **CLI-side LSP pool**, and a **CLI-side MCP host**. The roadmap and design rationale live in `darkcode-cli-implementation-plan.md`; per-phase build agents live in `.claude/agents/darkcode-p*.md`. **Read "Feature status" below before starting new work — several phases are partial or unimplemented.**

## Common commands

Run from the repo root unless noted:

| Command | Purpose |
|---|---|
| `bun install` | Install workspace deps |
| `bun run dev:server` | Hono API on `http://localhost:3000`, hot reload |
| `bun run dev:cli` | CLI in watch mode (run in a second terminal — needs server up) |
| `bun run build:cli` | Build the CLI package |
| `bun test` | Run the test suite (permission classifiers; uses `bun:test`) |
| `bun run link:cli` | Build and `bun link` the `darkcode` executable globally |
| `bun run --cwd packages/database db:generate` | Regenerate the Prisma client (run after schema edits) |
| `bun run --cwd packages/database db:push` | Push the Prisma schema to the configured Postgres |

**Typecheck (no script wired up):** `bunx tsc --noEmit -p packages/server/tsconfig.json` and `... packages/cli/tsconfig.json`. Both must come back **completely clean** — there are no expected or tolerated errors. Treat any error as yours to fix.

**Tests:** `bun test` (from the repo root, or scoped, e.g. `bun test packages/server`). Uses `bun:test`; `*.test.ts` are colocated next to source. Covered so far: the CLI **permission classifiers** (`bash-classifier`/`mcp-classifier`/`path-guards`), the CLI **gitignore matcher** (`gitignore` — parsing, anchoring, negation, `**`, nested files; verified against real `git check-ignore`), the CLI **edit replacer chain** (`replacers` — each strategy plus the ordering and uniqueness guarantees), the CLI **project context** (`project-context` — instruction-file discovery, ordering, caps, environment/git collection), the server **system prompt** (`system-prompt` — environment + instructions rendering), the CLI **text/edit path** (`text` line-ending + BOM + index-mapping primitives, `apply-edit` the pure `editFile` core — regression tests for dollar-token replacements and CRLF matching), and the server **billing path** (`credits` credit math, `token-estimate` compaction gate, `routes/credit-fallback` the credit-depleted BYOK-fallback decision + registry invariants, and `polar-outbox` retry — isolated via `mock.module` so it needs no env/DB/Polar). Broader coverage (routes end-to-end, etc.) is still Phase 8 work. There is no lint setup. When you touch types, also rely on `tsc`/editor diagnostics.

Note: server modules import `lib/env.ts`, which **throws at import** if required env vars are missing — so a server unit test can only import modules whose transitive graph avoids `env` (pure libs like `credits`/`token-estimate`, or `@darkcode/shared`), OR must mock the env-touching deps (`./polar`, the db client, `./logger`, `./sentry`) before importing, as `polar-outbox.test.ts` does.

The server's `postinstall` automatically runs `db:generate` in `packages/database`.

Platform note: development happens on **Windows**. Prefer cross-platform Node/Bun APIs over shelling out to Unix-only binaries (this has already bitten the LSP layer — see Known issues).

## Architecture

Bun workspace with four packages in `packages/*`. Cross-package imports use the `@darkcode/*` workspace specifiers. **Tool dispatch is client-side**: the server only declares tool schemas; the CLI executes everything (fs, bash, LSP, MCP) against the user's real `process.cwd()` and posts results back. New capabilities (LSP, MCP) follow this rule and run CLI-side so the server stays stateless.

### `@darkcode/shared` — the contract between CLI and server

- `schemas.ts` defines `Mode` (`BUILD` | `PLAN`) and the AI SDK `tool()` contracts. `readOnlyToolContracts` = `readFile`, `listDirectory`, `glob`, `grep` **+ the read-only LSP tools** (`lspDefinition`, `lspReferences`, `lspHover`, `lspDiagnostics`) — available in **both** modes. `buildToolContracts` adds `writeFile`, `editFile`, `bash`. `getToolContracts(mode)` is the single source of truth — server (`streamText` + `validateUIMessages`) and CLI (dispatch) both consume it.
- `project-context.ts` is the wire contract for **ambient project context** — `environment` (cwd, platform, OS version, local date, timezone, `bashAvailable`, git branch/HEAD/dirty count) and `instructions` (discovered `AGENTS.md` / `CLAUDE.md`). Gathered CLI-side because the server never sees the filesystem, then rendered into the system prompt. Caps live here so both ends agree: 24k chars per file, 32k combined, 6 files max.
- `models.ts` is the model registry and the **single source of truth for models**. `SupportedProvider` = `darkcode | anthropic | openai | openai-compatible | google | ollama`. `ByokProvider` = `anthropic | openai | deepseek | google | ollama` (ollama is keyless — included only for uniform typing). Each entry is a discriminated-union variant with `pricing`, `contextWindow`, optional `fallback`. Helpers: `findSupportedChatModel`, `modelRequiresApiKey`, `getModelByokProvider`, `getModelContextWindow`, `getModelFallbackId`. **Adding/changing a model goes here**, plus a resolver branch in `server/lib/models.ts`.

### `@darkcode/server` — Hono API (`packages/server/src`)

- `index.ts` mounts `/auth`, `/billing`, `/sessions`, `/chat`, `/health`. `requireAuth` guards everything except `/auth` and the Polar webhooks. Per-route rate limits + body limits; graceful shutdown; production misconfig warnings. `idleTimeout: 255` is intentionally high so long tool calls aren't cut. There is **no** `/attach` or `/pair` route (Phase 7 unimplemented).
- `routes/chat.ts` is the heart of the system. Per turn it:
  1. Looks up the model; for hosted (non-BYOK) models gates on Polar credits. **Credit-depleted fallback:** if the hosted model has a `fallback` and the user has that provider's BYOK key, it swaps to the fallback instead of refusing (the fallback is BYOK, so not metered).
  2. Merges incoming messages into both `session.messages` (raw, append-only) and `session.workingMessages` (what's sent to the model).
  3. **Compaction:** estimates `projectedNextRequestTokens`; if `>= 75%` of the model's `contextWindow`, compacts synchronously before the call. If still over the window after compacting, returns a structured **400 overflow refusal** rather than letting the provider error leak.
  4. Merges **MCP tools** (sent by the CLI in the request body as `mcpTools`) into the static contracts before `streamText` + `validateUIMessages`.
  5. `streamText` with `buildSystemPrompt({ mode, model, compactionSummary })`; streams `UIMessageStreamResponse` with metadata (`mode`, `model`, `durationMs`, `usage`, `compaction`, `contextUsage`).
  6. On finish (no pending tool calls): persists raw + working messages, and ingests a Polar `darkcode_usage` event for metered models only.
- `lib/models.ts` — `resolveChatModel(modelId, apiKeys)` → AI SDK model + `providerOptions` + `isMetered` + `provider`. Branches per provider: native Anthropic/OpenAI, `createOpenAI({baseURL})` for openai-compatible (DeepSeek) and Ollama (`OLLAMA_BASE_URL`, dummy key, `OLLAMA_DEFAULT_MODEL` override), `createGoogleGenerativeAI` for Gemini, and the Moonshot-backed `darkcode` model (with a fetch interceptor that disables Kimi thinking). BYOK keys arrive as `x-darkcode-<provider>-key` headers. Missing key → `ApiKeyRequiredError` → route 400 telling the user to run `/keys`.
- `lib/compaction.ts` — `compactWorkingContext()`: pins the last N=10 messages (+ `pinnedMessageIds`), summarizes the older range with the active model into a structured digest, returns the trimmed window + digest + `droppedCount`. The digest is injected into the **system prompt**, not the message array, so it survives the next pass.
- `lib/token-estimate.ts` — 4-chars/token heuristic; gates compaction only (billing uses provider `usage`).
- `lib/safe-error.ts` — strips provider request bodies out of `AI_APICallError` messages so the conversation isn't leaked back to the CLI as an error.
- `routes/sessions.ts` — CRUD + `POST /:id/compact` (the `/compact` command).
- `lib/polar.ts` + `lib/credits.ts` + `lib/polar-outbox.ts` — credit math + Polar SDK + a Postgres outbox that retries failed usage ingests. Event shape must stay exactly `{ name: "darkcode_usage", metadata: { credits } }` to match the Polar meter filter.
- `system-prompt.ts` — now renders an **`## Environment`** block (before the tool list, so the model reads the machine's constraints first; names Windows/macOS rather than `win32`/`darwin`, and states outright when `bash` is missing) and a **`## Project instructions`** block (discovered instruction files, least-specific first, each fenced in `<instructions path=…>` and framed as *untrusted repository content* that cannot override mode restrictions or the permission engine). Both are omitted entirely when the CLI sends no `projectContext`. Also branding-aware (hosted "Kimi K2.6" identity vs. generic engineer for BYOK), mode-specific tool lists incl. LSP, and a `## Prior conversation digest` block when a compaction summary exists.
- `lib/env.ts` — zod-validated env. Model-relevant additions: `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`), `OLLAMA_DEFAULT_MODEL`.

### `@darkcode/database` — Prisma

`Session` holds the full `UIMessage[]` in a Json column rather than normalizing per-message. Phase 3 added `workingMessages` (Json), `compactionSummary` (String?), `compactionAt` (DateTime?), `pinnedMessageIds` (String[]). Also: `AuditLog` (security events) and `PolarIngestOutbox` (failed-usage retry). There is **no** `DeviceToken` model (Phase 7 unimplemented). Generated client at `packages/database/generated/prisma`; import via `@darkcode/database/client` (`db`) and `@darkcode/database` (types).

### `@darkcode/cli` — OpenTUI + React terminal client (`packages/cli/src`)

- Entry `index.tsx` boots an OpenTUI renderer (`exitOnCtrlC: false` — Ctrl+C is handled by dialogs) with a memory router (`/`, `/sessions/new`, `/sessions/:id`). No `--help` flag (Phase 8).
- `lib/local-tools.ts` — client-side dispatch for all tools. `resolveInsideCwd` jails paths; reads/search/output are capped; bash runs with a **scrubbed env** (`scrubbedBashEnv` strips API-key/token/secret vars). `writeFile`/`editFile`/`bash` route through `checkPermission(...)` first. After a successful BUILD-mode write, it runs the **post-edit diagnostics loop** (`postEditDiagnostics` → LSP pool) and attaches `diagnostics` to the tool result. Dispatches the `lsp*` tools to the pool. PLAN mode rejects write/edit/bash (defense-in-depth).
- `lib/permissions/` — the permission engine (Phase 2). `engine.ts` `checkPermission(op)` classifies `{kind: "bash" | "fs" | "mcp"}` ops (deny → allow → ask → prompt), persists "allow always" rules, writes the audit log, and supports session **postures** (`normal` | `auto-edit` | `yolo`) via `setPermissionPosture`. `policy.ts` layers `defaults < ~/.darkcode/permissions.json < .darkcode/permissions.json`. `bash-classifier.ts` is shell-aware (splits pipelines, recurses into `$()`/backticks, default-deny on parse failure). `path-guards.ts` globs project-relative write paths. `mcp-classifier.ts` matches `mcp__server__tool` patterns. `audit.ts` appends JSONL to `~/.darkcode/audit.jsonl` (0600).
- `lib/lsp/` — CLI-side LSP pool (Phase 4). `pool.ts` keeps one warm `LspClient` per language, lazy-launched. `client.ts` speaks LSP over a child process via `vscode-jsonrpc`. `server-registry.ts` maps extensions → server commands (typescript-language-server, pyright, rust-analyzer, gopls). Used by `local-tools.ts` for the `lsp*` tools and the post-edit diagnostics loop. **No `lsp.symbols` tool** (planned, not built).
- `lib/mcp/` — CLI-side MCP host, **M1 only** (Phase 6). `config.ts` layers global+project `.darkcode/mcp.json` (**stdio transport only**). `host.ts` lazily connects, dedupes in-flight connects, lists tools, and dispatches `tools/call`. `discoverAllMcpTools()` runs at session start; the catalog is bundled into each chat request. Wire naming is `mcp__<server>__<tool>`. **Not built:** HTTP transport, health/restart/idle lifecycle, `/mcp add|remove|logs`, stderr capture.
- `hooks/use-chat.ts` — wraps `@ai-sdk/react`. Discovers MCP tools, bundles them into the request, and in `onToolCall` routes `mcp__*` calls through `checkPermission({kind:"mcp"})` + the MCP host, everything else through `executeLocalTool` (which does its own permission checks).
- `lib/api-keys.ts` — BYOK keys at `~/.darkcode/api-keys.json` (0600), forwarded only as `x-darkcode-*` headers. Ollama is keyless.
- UI: `screens/` (Home, NewSession, Session), `components/dialogs/` (incl. `keys`, `models`, `sessions`, `mcp`, `permissions`, `audit`), `components/messages/` (incl. `compaction-divider`), `components/status-bar.tsx` (shows posture + `ctx N%` gauge, amber@75/red@90), `components/command-menu/` (slash commands), `providers/` (Dialog, Keyboard, Prompt-config (mode/model/posture/contextUsage), Theme, Toast).

### Slash commands (`components/command-menu/commands.tsx`)

`/new`, `/agents` (mode switch), `/models`, `/keys`, `/sessions`, `/theme`, `/login`, `/logout`, `/upgrade` (credit top-up), `/pro` (Pro subscription checkout), `/usage`, `/compact`, `/mcp` (viewer), `/permissions` (viewer), `/audit` (viewer), `/yolo`, `/auto-edit`, `/safe`, `/exit`.

### Tool calling flow (end to end)

1. CLI sends user message + `{ mode, model, mcpTools? }` to `POST /chat`.
2. Server gates credits (with fallback), maybe compacts, merges MCP + built-in tools → `streamText`.
3. Model emits a tool call; AI SDK surfaces it via `useChat.onToolCall`.
4. CLI runs `executeLocalTool` (built-in, self-gated) or the MCP host (gated in the hook), posts the result back. BUILD writes attach LSP diagnostics.
5. Server resumes the stream; on finish persists raw + working messages and ingests Polar usage (metered models only).

### Modes & postures

- `PLAN` — read-only tools (incl. LSP) only. `BUILD` — full tools incl. shell. Mode is carried in the request and re-stamped onto message metadata; switching mid-session is fine.
- Permission **posture** (orthogonal to mode): `normal` prompts on unmatched side effects; `auto-edit` auto-allows fs writes **except `denyWrite` paths** (`.env`, `*.pem`, `**/.ssh/**`, …), with bash/MCP still gated; `yolo` auto-allows everything (logged loudly).

### Models & billing

- "Kimi K2.6" is the user-facing label for the hosted Moonshot/Kimi model. Never reveal the upstream provider name (enforced in `system-prompt.ts`).
- **Metering is per-resolution, not per-model.** Any model DarkCode can host (`canBeHosted: true`) is metered (`isMetered: true`) **when it runs on our infra** — the hosted `darkcode` model always, and Anthropic/OpenAI/DeepSeek/**Google/Gemini** when the user has **no** BYOK key for that provider and the server has the provider's hosted key configured (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY`). The **same model id is unmetered** when the user supplies a BYOK key (`isMetered: false`) — their key always wins. **Ollama** (local, `canBeHosted: false`) is always unmetered. `chat.ts` resolves the model first, then gates credits on `resolvedModel.isMetered`; `credits.ts` no longer rejects third-party models (the "don't double-charge BYOK" guard is now the `isMetered` check at the call site). Credit-depleted fallback to a BYOK model is also unmetered.
- The Polar meter is keyed off the event `name` + `credits` metadata — don't rename either without updating the Polar dashboard filter.

## Feature status (what to build on, what's missing)

Cross-reference `darkcode-cli-implementation-plan.md` §10. The plan's own status table is stale — this reflects the actual tree:

| Phase | State |
|---|---|
| P0 Foundations, P2 Permissions, P3 Compaction/sessions | ✅ shipped |
| P1 Multi-model (Anthropic/OpenAI/DeepSeek/**Gemini**/**Ollama**) | ✅ shipped |
| P4 LSP | ✅ working **cross-platform incl. Windows**; still missing `lsp.symbols` (planned enhancement) |
| P6 MCP | ⚠️ **M1 only** (stdio); M2 (HTTP, lifecycle, `/mcp add\|remove\|logs`) **not built** |
| P5 Kiro spec engine | ❌ not implemented (no `cli/lib/specs/`, no `/spec` commands) |
| P7 Remote attach | ❌ not implemented (no `DeviceToken`, no `/attach`·`/pair`) |
| P8 Hardening | ❌ not implemented (no tests, no `--help`, README stale, empty `scripts/`) |

The unbuilt phases still have their build-agent briefs in `.claude/agents/darkcode-p{5,6,7,8}.md` (and `p1`, `p4`).

## Known issues / gotchas

- **Compaction under-compacts rather than splitting a turn.** `lib/compaction.ts` snaps the retained-window cutoff back to a `user`-message boundary, so a window that would otherwise begin mid-turn just keeps a few extra messages. A single oversized turn therefore may not shrink — `chat.ts` still returns the structured 400 overflow refusal in that case. (It doesn't stub dropped tool results per the plan §7.1 design, but because the window now only ever starts on a user turn, `validateUIMessages`/`convertToModelMessages` no longer reject the working set.)
- **`lsp.symbols` is still not built** (workspace/document symbol search) — see Feature status. The other LSP tools (`lspDefinition`/`lspReferences`/`lspHover`/`lspDiagnostics`) and the post-edit diagnostics loop work cross-platform, including Windows.

_Recently improved: **`editFile` now falls back through fuzzy matching strategies** instead of requiring a byte-exact `oldString`. `lib/replacers.ts` adds `trimmed` → `indentation-flexible` → `line-trimmed` → `whitespace-normalized` → `block-anchor`, tried strictest-first only after an exact match **misses**. An exact match that is *ambiguous* still errors rather than falling through — if the model's text appears three times verbatim, the useful answer is "quote more context", not a guess. The safety property: a strategy never describes a transformation, it **yields candidate substrings that exist verbatim in the file**, and the caller requires exactly one unique candidate before splicing. So a strategy can be wrong about *which* region was meant, but cannot fabricate one. Fuzzy matches are reported back to the model as `matchedBy` + `note` rather than passing silently. Measured on 596 realistic perturbations of this repo's own source: recovery rose from **27% to 100%** with **0** wrong regions replaced._

_Recently improved: **`grep` now respects `.gitignore` and supports case-insensitive search**. It previously skipped only `node_modules`/`.git` by substring, so `dist/`, `build/`, coverage output and lockfiles consumed the 2,000-file scan budget and returned matches from generated code. `lib/gitignore.ts` implements the real semantics (anchoring, negation, directory-only rules, `**` in every position, nested `.gitignore` files, last-match-wins precedence) and is verified against `git check-ignore` on 96 path/pattern combinations. The scan is now a recursive walk rather than `Bun.Glob.scan` so ignored directories are **pruned** instead of enumerated-then-filtered — sound because git cannot re-include a path under an excluded parent. The budget counts only files actually searched. Symlinks are neither followed nor returned (cycle safety). The `grep` contract gained an optional `ignoreCase` boolean; arbitrary regex flags are deliberately **not** exposed, because `g` makes `RegExp.test` stateful via `lastIndex` and would silently skip every other matching line._

_Recently fixed: the **text-shape bugs in the file tools**. `editFile` used `String.replace`, which interprets `$$`/`$&`/`` $` ``/`$'` in the *replacement* as substitution patterns — it silently wrote wrong bytes and reported success. It also matched the model's LF-delimited `oldString` against raw CRLF file contents, so every multi-line edit to a Windows file threw "oldString not found in file". `readFile` and `grep` split on `"\n"` alone, leaving a trailing `\r` on every line of a CRLF file (breaking `$`-anchored patterns and leaking control characters into the model's context). All of it now goes through `lib/text.ts` (normalize to LF at the boundary, splice by index, restore the file's own line ending and BOM on write) and `lib/apply-edit.ts` (the pure `editFile` core). Edits are **surgical** — the match is located in normalized space and mapped back to raw offsets, so a mixed-ending file keeps every line the model didn't touch byte-for-byte. Regression tests live in `lib/text.test.ts` and `lib/apply-edit.test.ts`._

_Recently fixed (were listed here): Windows LSP binary resolution (`lib/lsp/client.ts` now uses a PATHEXT-aware `resolveBinaryPath` instead of `spawn("which")` — verified spawning `typescript-language-server` and returning diagnostics on Windows); the LSP pool no longer installs Ctrl+C-hijacking `SIGINT`/`SIGTERM` handlers (cleanup is synchronous on `exit` via `LspClient.killSync()`); `auto-edit` posture now enforces the fs `denyWrite` list before auto-allowing; and the default bash policy no longer auto-allows `cat`/`head`/`tail **` (they route to a prompt)._

_Chatting in an old session could throw and dump the **whole conversation** as a red error in the CLI. Two root causes, both fixed in `chat.ts`: (1) a failed/aborted turn can persist an assistant **husk** (`{ id: "", parts: [] }`); `validateUIMessages` rejects it and its error embeds the entire message array — `sanitizeMessages()` now drops content-less messages and backfills missing ids on both the raw and working sets before validation, recovering corrupted sessions. (2) the transcript was validated/converted against the **mode-restricted** tool set, so a `bash`/`write`/MCP tool part recorded in a past turn (esp. a dangling one) hit "No tool schema found for tool part …"; `validateUIMessages`/`convertToModelMessages` now decode against the BUILD **superset** (`decodeTools`), while only `streamText`'s `tools` stay mode-restricted. The dump itself happened because `@ai-sdk/react` throws `new Error(await response.text())` on a non-2xx, making the whole response body the `chat.error.message`, and `index.ts`'s dev error branch returned it unclipped. Hardened both ends too: `index.ts` now `clip()`s every error body (even in dev), and the CLI `formatChatErrorMessage()` unwraps `{"error":…}` and caps length._

## TypeScript

Strict mode, bundler resolution, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. No `as any`; the model registry is `as const satisfies` — narrow new entries cleanly rather than widening the union. Typecheck with the per-package `tsc --noEmit` invocations above.
