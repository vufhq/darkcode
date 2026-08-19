import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  convertToModelMessages,
  jsonSchema,
  streamText,
  tool,
  validateUIMessages,
  type InferUITools,
  type LanguageModelUsage,
  type Tool,
  type ToolSet,
  type UIMessage,
} from "ai";
import { db } from "@darkcode/database/client";
import type { Prisma } from "@darkcode/database";
import {
  BYOK_PROVIDERS,
  BYOK_PROVIDER_HEADER,
  BYOK_PROVIDER_LABELS,
  findSupportedChatModel,
  getModelContextWindow,
  getModelFallbackId,
  getToolContracts,
  toolInputSchemas,
  isProTierModel,
  Mode,
  modeSchema,
  projectContextSchema,
  todoListSchema,
  type ModeType,
  type ToolContracts,
} from "@darkcode/shared";
import { env } from "../lib/env";
import { buildSystemPrompt } from "../system-prompt";
import { webSearch } from "../lib/web-search";
import { compactWorkingContext } from "../lib/compaction";
import { projectNextRequestTokens, RESPONSE_TOKEN_RESERVE } from "../lib/token-estimate";
import { safeErrorMessage } from "../lib/safe-error";
import type { AuthenticatedEnv } from "../middleware/require-auth";
import { getAvailableCreditsBalance, hasActiveProSubscription } from "../lib/polar";
import { ingestAiUsageWithOutbox } from "../lib/polar-outbox";
import { claimIdempotencyKey } from "../lib/idempotency";
import { calculateCreditsForUsage, estimateCreditsForProjectedTurn } from "../lib/credits";
import { getPendingCredits, reserveCredits } from "../lib/credit-reservation";
import { captureException } from "../lib/sentry";
import { logAuditEvent } from "../lib/audit";
import {
  ApiKeyRequiredError,
  HostedProviderNotConfiguredError,
  isSupportedChatModel,
  resolveChatModel,
  type ProviderApiKeys,
  type ResolvedModel,
} from "../lib/models";

type ChatMessageMetadata = {
  mode?: ModeType;
  model?: string;
  durationMs?: number;
  usage?: LanguageModelUsage;
  // Populated on the assistant message returned from a turn that triggered
  // compaction. CLI uses this to render an inline `CompactionDivider` and
  // refresh the status bar's window-utilization indicator.
  compaction?: {
    droppedCount: number;
    summary: string;
  };
  // Snapshot of token utilization for the just-completed request, so the CLI
  // can drive the status-bar gauge without re-estimating client-side.
  contextUsage?: {
    estimatedTokens: number;
    contextWindow: number;
  };
};

type DarkcodeUIMessage = UIMessage<ChatMessageMetadata, never, InferUITools<ToolContracts>>;

// Wire shape for an MCP tool advertised by the CLI host. We don't validate
// the JSON Schema body — only the LLM provider sees it, and a malformed
// schema will surface as a model error rather than a security issue.
const mcpToolSchema = z.object({
  // `mcp__<server>__<tool>` — bounded so a single tool name can't bloat the
  // catalog we hand to the model every turn.
  name: z.string().min(1).max(128),
  // Surfaced verbatim to the model, so cap it: an unbounded description is a
  // request-bloat and prompt-injection surface.
  description: z.string().max(2_000).default(""),
  inputSchema: z.unknown(),
});

const submitSchema = z.object({
  // Session ids are CUIDs; bound the length so an oversized string fails fast
  // before touching the DB. (IDOR is already blocked by the userId-scoped
  // findUnique downstream.)
  id: z.string().min(1).max(64),
  // The CLI's transport sends at most 2 messages per turn (the new user turn,
  // optionally paired with the assistant message carrying tool results), so a
  // small cap is generous headroom while bounding the merge/persist work.
  messages: z
    .array(
      z.custom<DarkcodeUIMessage>((value) => {
        return value != null && typeof value === "object" && "id" in value && "parts" in value;
      }),
    )
    .min(1)
    .max(20),
  mode: modeSchema,
  model: z.string().refine(isSupportedChatModel, "Unsupported model"),
  // MCP tools discovered CLI-side this turn. Optional: a session with no MCP
  // servers configured omits the field entirely. Capped so a malicious or
  // runaway config can't inject an unbounded tool catalog.
  mcpTools: z.array(mcpToolSchema).max(64).optional(),
  // Ambient project/machine context gathered CLI-side (cwd, platform, git
  // state, AGENTS.md / CLAUDE.md). Optional: an older CLI omits it entirely,
  // and the prompt simply renders without those blocks. Caps live in the
  // shared schema so both ends agree on them.
  projectContext: projectContextSchema.optional(),
  // Session task list, owned and re-sent by the CLI. The server is stateless
  // and only renders it into the system prompt.
  todos: todoListSchema.optional(),
});

const submitValidator = zValidator("json", submitSchema, (result, c) => {
  if (!result.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

function hasPendingToolCalls(message: DarkcodeUIMessage) {
  return message.parts.some((part) => {
    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      const state = (part as { state?: string }).state;
      return state !== "output-available" && state !== "output-error";
    }

    return false;
  });
};

// A failed or aborted turn can leave an assistant "husk" in the stored
// transcript — a message with no parts and/or an empty id (e.g. a turn that
// errored before the model produced anything). The AI SDK's
// `validateUIMessages` rejects these, and its error embeds the ENTIRE message
// array, which previously surfaced in the CLI as a full-conversation dump and
// made the session impossible to chat in. Drop content-less messages and
// backfill any missing id so the transcript always validates, recovering old
// corrupted sessions and preventing us from re-persisting the husk.
function sanitizeMessages(messages: DarkcodeUIMessage[]): DarkcodeUIMessage[] {
  const cleaned: DarkcodeUIMessage[] = [];
  for (const message of messages) {
    if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
      continue;
    }
    if (typeof message.id !== "string" || message.id.length === 0) {
      cleaned.push({ ...message, id: `restored-${cleaned.length}-${Date.now()}` });
    } else {
      cleaned.push(message);
    }
  }
  return cleaned;
}

function readApiKeysFromHeaders(headers: Headers): ProviderApiKeys {
  const apiKeys: ProviderApiKeys = {};
  for (const provider of BYOK_PROVIDERS) {
    const value = headers.get(BYOK_PROVIDER_HEADER[provider]);
    if (value && value.length > 0) {
      apiKeys[provider] = value;
    }
  }
  return apiKeys;
}

const app = new Hono<AuthenticatedEnv>()
  .post(
    "/",
    submitValidator,
    async (c) => {
      const userId = c.get("userId");
      const log = c.get("log");
      const requestId = c.get("requestId");
      const { id, messages, mode, model, mcpTools, projectContext, todos } = c.req.valid("json");

      // Idempotency: optional `Idempotency-Key` header. Two requests from the
      // same user with the same key within the TTL only get processed once.
      const idempotencyKey = c.req.header("idempotency-key");
      if (idempotencyKey) {
        const claimed = await claimIdempotencyKey("chat", userId, idempotencyKey);
        if (!claimed) {
          log.info({ idempotencyKey, sessionId: id }, "chat.idempotency_duplicate");
          return c.json(
            { error: "Duplicate request — this idempotency key is already in flight or recently completed." },
            409,
          );
        }
      }

      const modelDefinition = findSupportedChatModel(model);
      if (!modelDefinition) {
        return c.json({ error: "Unsupported model" }, 400);
      }

      // Effective model id we'll actually run with. May be swapped to the
      // registered fallback if the primary model can't run this turn (e.g.
      // credits depleted on the hosted model and the user has a BYOK key).
      let effectiveModelId: string = model;
      const apiKeys = readApiKeysFromHeaders(c.req.raw.headers);

      // Resolve the model up front so the credit gate can key off how the turn
      // will actually run. A model is *metered* (billed in DarkCode credits)
      // only when it resolves to our hosted infra; if the user supplied a BYOK
      // key for its provider it resolves to their account instead and isn't
      // metered. resolveChatModel already encodes that BYOK-vs-hosted decision,
      // so we reuse it rather than re-deriving the billing mode from the
      // registry (which is what `requiresApiKey` alone can't tell us anymore —
      // hosted Claude/GPT/etc. are now metered even though they "require" a key).
      let resolvedModel: ResolvedModel;
      // Balance as read from Polar for this turn. `null` means we couldn't read
      // it (fail-open, see below) — kept in the outer scope because the
      // projected-cost gate further down re-checks it once the real request
      // size is known.
      let creditsBalance: number | null = null;
      try {
        resolvedModel = resolveChatModel(effectiveModelId, apiKeys);
      } catch (error) {
        if (error instanceof ApiKeyRequiredError) {
          return c.json(
            {
              error: `Missing ${error.provider} API key. Run /keys to add one.`,
              provider: error.provider,
            },
            400,
          );
        }
        if (error instanceof HostedProviderNotConfiguredError) {
          // We can't host this model (no server-side key for its provider) and
          // the user hasn't brought their own — point them at BYOK.
          return c.json(
            {
              error: `This model isn't available on credits right now. Add your own ${error.provider} API key with /keys to use it.`,
              provider: error.provider,
            },
            400,
          );
        }
        throw error;
      }

      // Gate on DarkCode credits only when this turn runs on our hosted infra.
      // BYOK turns bill against the user's own provider account, so they're
      // never gated. When a hosted turn has no credits left we swap to the
      // model's registered fallback IF the user has that provider's BYOK key
      // (so the fallback turn is unmetered); otherwise we refuse with 402.
      if (resolvedModel.isMetered) {
        // Premium-model tiering (Item 4): premium hosted models require an active
        // Pro subscription. Only metered turns (running on our infra) reach here
        // — a BYOK turn bills the user's own account and is never tier-gated.
        // Inert until Pro is provisioned: with POLAR_PRO_PRODUCT_ID unset,
        // hasActiveProSubscription returns false but we don't even ask, so
        // premium models stay available to anyone on credits (current behavior).
        if (env.POLAR_PRO_PRODUCT_ID && isProTierModel(effectiveModelId)) {
          let isPro: boolean;
          try {
            isPro = await hasActiveProSubscription(userId);
          } catch (error) {
            // Fail OPEN on a Polar/network glitch — same stance as the credit
            // gate below. Walling a possibly-paying user out of a model because
            // the billing system hiccuped is the churn moment we refuse to make.
            log.warn(
              { err: error, userId, requestId },
              "pro_check_unavailable_fail_open",
            );
            captureException(error, { userId, requestId, tags: { kind: "polar_pro_check" } });
            isPro = true;
          }

          if (!isPro) {
            void logAuditEvent({ userId, action: "pro.required", requestId });
            // All premium models require an API key, so there's always a BYOK
            // escape hatch to point at. `code` lets the CLI render an actionable
            // affordance without string-matching the human message.
            const byokHint = modelDefinition.requiresApiKey
              ? ` Or add your own ${BYOK_PROVIDER_LABELS[modelDefinition.byokProvider]} API key with /keys to use it on your own account.`
              : "";
            return c.json(
              {
                error: `${modelDefinition.displayName} is a Pro model. Subscribe with /pro to unlock it.${byokHint}`,
                code: "pro_required",
              },
              402,
            );
          }
        }

        try {
          creditsBalance = await getAvailableCreditsBalance(userId);
        } catch (error) {
          // Fail OPEN on a transient balance-fetch failure (Polar down / network).
          // Hard-blocking a paying user mid-turn because the billing system had a
          // glitch is the exact "you look broke" churn moment we refuse to create.
          // The turn still proceeds and is metered in onFinish (the usage ingest
          // self-queues to the outbox on failure), so the only exposure is a
          // genuinely-depleted user sneaking a single turn during an outage.
          // Logged at warn + captured so the outage still pages us.
          log.warn(
            { err: error, userId, requestId },
            "credits_balance_unavailable_fail_open",
          );
          captureException(error, { userId, requestId, tags: { kind: "polar_balance" } });
          creditsBalance = null;
        }

        // `null` == couldn't read the balance; we deliberately don't treat that
        // as depleted (fail open). Only a confirmed non-positive balance gates.
        if (creditsBalance !== null && creditsBalance <= 0) {
          const fallbackId = getModelFallbackId(effectiveModelId);
          const fallbackDef = fallbackId ? findSupportedChatModel(fallbackId) : null;
          const fallbackKeyAvailable =
            fallbackDef && fallbackDef.requiresApiKey
              ? apiKeys[fallbackDef.byokProvider] != null
              : fallbackDef != null;
          if (fallbackDef && fallbackKeyAvailable) {
            log.info(
              { userId, requestId, from: effectiveModelId, to: fallbackDef.id },
              "chat.credits_depleted_fallback",
            );
            effectiveModelId = fallbackDef.id;
            // Re-resolve as the fallback. fallbackKeyAvailable guarantees the
            // BYOK key is present, so this resolves to the user's account
            // (unmetered) and won't throw.
            resolvedModel = resolveChatModel(effectiveModelId, apiKeys);
          } else {
            void logAuditEvent({ userId, action: "credits.depleted", requestId });
            // `code` is a stable, machine-readable signal so the CLI can render
            // an actionable top-up affordance instead of string-matching the
            // human message (which we're free to reword). See http-errors.ts.
            return c.json(
              {
                error: "No credits remaining. Run /upgrade to buy more credits.",
                code: "credits_depleted",
              },
              402,
            );
          }
        }
      }

      const session = await db.session.findUnique({
        where: { id, userId },
      });

      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const startTime = Date.now();

      // One abort budget for the whole turn: fire if the client disconnects OR
      // the turn exceeds the stream-timeout budget. Shared by the optional
      // compaction summarizer call and the main stream below, so a hung or
      // trickling upstream provider can't pin the request open indefinitely.
      const turnAbortSignal = AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(env.CHAT_STREAM_TIMEOUT_MS),
      ]);

      // Merge MCP tools (CLI-side, discovered this turn) into the static
      // contracts. MCP entries have no `execute` — dispatch is client-side via
      // useChat's onToolCall, identical to the built-in tools. The merged set
      // is what we hand to both streamText (for the LLM's tool catalog) and
      // validateUIMessages (so the validator doesn't reject mcp__* parts).
      const builtInTools = getToolContracts(mode);
      const mcpDynamicTools: Record<string, Tool> = {};
      if (mcpTools && mcpTools.length > 0) {
        for (const t of mcpTools) {
          mcpDynamicTools[t.name] = tool({
            description: t.description,
            inputSchema: jsonSchema(
              (t.inputSchema as Parameters<typeof jsonSchema>[0]) ?? {
                type: "object",
                properties: {},
              },
            ),
          });
        }
      }
      // The static type of `tools` is the built-in ToolContracts; we widen to
      // ToolSet for runtime use because the MCP set is discovered per-request.
      // This is the set the *model* may call this turn — mode-restricted, so
      // PLAN excludes write/edit/bash.
      // `webSearch` is the one tool that executes HERE rather than on the CLI.
      // Everything else needs the user's filesystem or network position; search
      // needs a provider credential, and MOONSHOT_API_KEY lives on the server
      // and nowhere else. Attaching `execute` means the AI SDK runs it
      // in-process and streams the result — the call never reaches the client,
      // which is why `local-tools.ts` has no case for it.
      //
      // Note this works for every model, not just the Moonshot-backed one: a
      // user on BYOK Anthropic still gets search, because the search is a
      // separate server-to-Moonshot call rather than a capability of the
      // conversation's model.
      const serverExecutedTools = {
        webSearch: tool({
          description: builtInTools.webSearch.description,
          inputSchema: toolInputSchemas.webSearch,
          execute: async ({ query }: { query: string }) =>
            webSearch(query, {
              apiKey: env.MOONSHOT_API_KEY,
              baseUrl: env.MOONSHOT_BASE_URL,
              model: env.MOONSHOT_SEARCH_MODEL,
            }),
        }),
      };

      const tools = {
        ...builtInTools,
        ...serverExecutedTools,
        ...mcpDynamicTools,
      } as unknown as ToolSet;

      // Decoding the stored transcript is mode-independent: a session created
      // in BUILD can be continued in PLAN, and its history legitimately holds
      // write/edit/bash tool parts (including a dangling one from an
      // interrupted turn). validateUIMessages/convertToModelMessages need every
      // tool that could appear in history, or they throw "No tool schema found
      // for tool part …" — which previously surfaced as a full-transcript dump.
      // So we decode against the BUILD superset; the model is still restricted
      // to `tools` above.
      const decodeContracts = getToolContracts(Mode.BUILD);
      const decodeTools = { ...decodeContracts, ...mcpDynamicTools } as unknown as ToolSet;

      // Merge incoming messages into both the raw transcript and the working
      // context separately. The raw transcript (`session.messages`) is
      // append-only and never edited by compaction; the working context
      // (`session.workingMessages`) is what we send to the model and gets
      // pruned when the window fills. New sessions have empty `workingMessages`
      // — backfill from `messages` so existing rows behave correctly without
      // a data migration.
      const rawPrevious = Array.isArray(session.messages)
        ? (session.messages as unknown as DarkcodeUIMessage[])
        : [];
      const workingPreviousRaw = Array.isArray(session.workingMessages)
        ? (session.workingMessages as unknown as DarkcodeUIMessage[])
        : [];
      const workingPrevious =
        workingPreviousRaw.length > 0 ? workingPreviousRaw : rawPrevious;

      function mergeIncoming(base: DarkcodeUIMessage[]): DarkcodeUIMessage[] {
        const merged = [...base];
        for (const message of messages) {
          const stamped = {
            ...message,
            metadata: { ...message.metadata, mode, model },
          } satisfies DarkcodeUIMessage;
          const idx = merged.findIndex((m) => m.id === stamped.id);
          if (idx === -1) merged.push(stamped);
          else merged[idx] = stamped;
        }
        return merged;
      }

      // Sanitize after merging so a husk from a previously-errored turn can't
      // make `validateUIMessages` reject the whole transcript below.
      const rawMerged = sanitizeMessages(mergeIncoming(rawPrevious));
      let workingMerged = sanitizeMessages(mergeIncoming(workingPrevious));

      // Compaction trigger: project the next request's token count against the
      // model's context window. Compact at >=75% so the model has headroom
      // for its own response (the reserve is baked into the projection).
      const contextWindow = getModelContextWindow(effectiveModelId);
      const builtSystemPromptForProjection = buildSystemPrompt({
        mode,
        model: effectiveModelId,
        compactionSummary: session.compactionSummary,
        projectContext,
        todos,
      });
      const projectedTokens = projectNextRequestTokens({
        systemPrompt: builtSystemPromptForProjection,
        workingMessages: workingMerged,
        incomingMessages: [],
      });

      let compactionEvent: { droppedCount: number; summary: string } | null = null;
      let compactionUsage: LanguageModelUsage | null = null;
      let activeCompactionSummary: string | null = session.compactionSummary ?? null;

      if (projectedTokens / contextWindow >= 0.75) {
        log.info(
          {
            sessionId: id,
            projectedTokens,
            contextWindow,
            messageCount: workingMerged.length,
          },
          "chat.compaction_triggered",
        );

        try {
          const result = await compactWorkingContext({
            rawWorkingMessages: workingMerged,
            pinnedMessageIds: session.pinnedMessageIds ?? [],
            previousSummary: activeCompactionSummary,
            summarizerModel: resolvedModel.model,
            abortSignal: turnAbortSignal,
          });

          if (result.droppedCount > 0) {
            // Compactor preserves message identity; safe to narrow back to our
            // typed metadata shape.
            workingMerged = result.workingMessages as DarkcodeUIMessage[];
            activeCompactionSummary = result.summary;
            compactionEvent = {
              droppedCount: result.droppedCount,
              summary: result.summary,
            };
            // The summarizer call consumed real tokens. When the active model
            // is hosted (metered), meter it — otherwise repeated compaction is
            // unbilled API spend on our account.
            compactionUsage = result.usage;
          }
        } catch (error) {
          // Compaction failure should not block the user's turn. Log it,
          // skip compaction, and let the upstream-window error (if any) surface
          // naturally — the user can /compact manually as a workaround.
          log.error({ err: error, sessionId: id }, "chat.compaction_failed");
          captureException(error, {
            userId,
            requestId,
            tags: { kind: "compaction" },
            extra: { sessionId: id },
          });
        }
      }

      // Meter the summarizer call for hosted models. Billed here (not in the
      // stream's onFinish) because the tokens were already spent regardless of
      // whether this turn later overflows the window or ends with pending tool
      // calls — both of which short-circuit the onFinish billing path. The
      // ingest is fire-and-forget: it self-queues to the outbox on failure.
      if (compactionUsage && resolvedModel.isMetered) {
        try {
          const { credits } = calculateCreditsForUsage({
            provider: resolvedModel.provider,
            model: resolvedModel.modelId,
            usage: compactionUsage,
          });
          void ingestAiUsageWithOutbox({
            externalCustomerId: userId,
            eventId: `chat-compaction:${id}:${startTime}`,
            credits,
          });
        } catch (error) {
          log.error({ err: error, sessionId: id }, "chat.compaction_credit_calc_failed");
          captureException(error, {
            userId,
            requestId,
            tags: { kind: "polar_compaction_credit_calc" },
            extra: { sessionId: id },
          });
        }
      }

      // Post-compaction overflow refusal: if a single incoming message still
      // blows the window on its own, fail loudly instead of waiting for the
      // upstream provider to 4xx.
      const finalProjection = projectNextRequestTokens({
        systemPrompt: buildSystemPrompt({
          mode,
          model: effectiveModelId,
          compactionSummary: activeCompactionSummary,
          projectContext,
          todos,
        }),
        workingMessages: workingMerged,
        incomingMessages: [],
      });
      if (finalProjection > contextWindow) {
        return c.json(
          {
            error:
              "This turn exceeds the model's context window even after compaction. Trim the latest message or switch to a model with a larger window.",
            projectedTokens: finalProjection,
            contextWindow,
          },
          400,
        );
      }

      // Projected-cost gate. The balance check above only established that the
      // user has *some* credit; now that the real request size is known, check
      // that they can actually afford this turn. Two things this closes:
      //
      //   - a 1-credit account starting a 786k-token turn on a large-window
      //     model (~100x the gate), and
      //   - the check-then-act race, since the debit only lands after the
      //     stream finishes. Concurrent turns each reserve their estimate, and
      //     the reservation total is subtracted from the balance here.
      //
      // Skipped entirely when the balance is unknown (`null`) — that's the
      // deliberate fail-open stance from the gate above, and it would be
      // perverse to reintroduce a hard block here.
      let releaseReservation: (() => Promise<void>) | null = null;
      if (resolvedModel.isMetered && creditsBalance !== null) {
        const projectedCredits = estimateCreditsForProjectedTurn({
          provider: resolvedModel.provider,
          model: resolvedModel.modelId,
          projectedInputTokens: finalProjection,
          responseReserveTokens: RESPONSE_TOKEN_RESERVE,
        });
        const pending = await getPendingCredits(userId);
        const available = creditsBalance - pending;

        if (projectedCredits > available) {
          void logAuditEvent({ userId, action: "credits.insufficient_for_turn", requestId });
          log.info(
            { userId, requestId, projectedCredits, creditsBalance, pending },
            "chat.turn_exceeds_balance",
          );
          return c.json(
            {
              error:
                pending > 0
                  ? "Not enough credits for this turn while your other requests are still running. Wait for them to finish, or run /upgrade to add credits."
                  : "This turn needs more credits than you have left. Run /upgrade to add credits, or switch to a smaller model or a shorter conversation.",
              code: "credits_depleted",
              projectedCredits,
              availableCredits: available,
            },
            402,
          );
        }

        releaseReservation = await reserveCredits(userId, projectedCredits);
      }

      // Release the reservation however this turn ends — normal finish, client
      // disconnect, or an upstream throw. The real debit is ingested in
      // onFinish; the reservation only has to cover the window between the
      // gate and that ingest.
      const releaseOnce = async () => {
        if (!releaseReservation) return;
        const release = releaseReservation;
        releaseReservation = null;
        await release();
      };

      let nextMessages: DarkcodeUIMessage[];
      let modelMessages: Awaited<ReturnType<typeof convertToModelMessages>>;
      try {
        nextMessages = await validateUIMessages<DarkcodeUIMessage>({
          messages: workingMerged,
          tools: decodeTools,
        });
        modelMessages = await convertToModelMessages(nextMessages, { tools: decodeTools });
      } catch (error) {
        // Decoding threw before the stream ever started — free the reservation
        // rather than leaving it to time out.
        await releaseOnce();
        throw error;
      }
      let completedUsage: LanguageModelUsage | null = null;

      const result = streamText({
        model: resolvedModel.model,
        system: buildSystemPrompt({
          mode,
          model: effectiveModelId,
          compactionSummary: activeCompactionSummary,
          projectContext,
          todos,
        }),
        messages: modelMessages,
        tools,
        providerOptions: resolvedModel.providerOptions,
        // Abort when the client disconnects or the turn's timeout budget is
        // exhausted (see turnAbortSignal above) so we don't keep burning
        // provider tokens after the user navigated away or on a hung upstream.
        abortSignal: turnAbortSignal,
        onFinish(event) {
          completedUsage = event.totalUsage;
        },
      });

      return result.toUIMessageStreamResponse<DarkcodeUIMessage>({
        originalMessages: nextMessages,
        messageMetadata({ part }) {
          if (part.type === "start") {
            return {
              mode,
              model: effectiveModelId,
              ...(compactionEvent ? { compaction: compactionEvent } : {}),
            };
          }

          if (part.type !== "finish") return undefined;

          return {
            mode,
            model: effectiveModelId,
            durationMs: Date.now() - startTime,
            ...(completedUsage ? { usage: completedUsage } : {}),
            ...(compactionEvent ? { compaction: compactionEvent } : {}),
            contextUsage: {
              estimatedTokens: finalProjection,
              contextWindow,
            },
          };
        },
        async onFinish(event) {
          // Always let the reservation go, whatever the turn did. The real
          // debit is ingested just below.
          await releaseOnce();

          if (event.isAborted) return;

          // Meter BEFORE the pending-tool-call guard below.
          //
          // No tool contract defines an `execute` — every tool, built-in and
          // MCP alike, is dispatched client-side — so a turn where the model
          // calls a tool ends with that part still pending. In an agentic
          // coding tool that describes *most* turns. Billing after the guard
          // meant a ten-step task charged only for the final text-only turn
          // while we paid the provider for all eleven.
          //
          // The event id is derived from the response message id and the
          // outbox de-duplicates on it, so metering here stays idempotent
          // even though the turn may be continued below.
          if (completedUsage && resolvedModel.isMetered) {
            try {
              const billableUsage = calculateCreditsForUsage({
                provider: resolvedModel.provider,
                model: resolvedModel.modelId,
                usage: completedUsage,
              });

              // Inline-first; queues to the Postgres-backed outbox on failure so
              // the background sweeper can retry without losing the event.
              await ingestAiUsageWithOutbox({
                externalCustomerId: userId,
                eventId: `chat-message:${event.responseMessage.id}`,
                credits: billableUsage.credits,
              });
            } catch (error) {
              // calculateCreditsForUsage can throw (bad usage shape). Surface it
              // but don't fail the request — the response has already streamed.
              log.error(
                {
                  err: error,
                  sessionId: id,
                  messageId: event.responseMessage.id,
                },
                "polar_credit_calc_failed",
              );
              captureException(error, {
                userId,
                requestId,
                tags: { kind: "polar_credit_calc" },
                extra: { sessionId: id, messageId: event.responseMessage.id },
              });
            }
          }

          // Persistence still waits for the turn to settle: a transcript with a
          // dangling tool call isn't a valid resume point, and the CLI resends
          // the messages on the next request anyway.
          if (hasPendingToolCalls(event.responseMessage)) return;

          // `event.messages` is `nextMessages` (the working set we sent) plus
          // whatever the model produced. Persist that as the new working
          // context, and append only the *new* assistant/tool messages to the
          // raw transcript so we don't accidentally drop any history.
          const newAssistantMessages = event.messages.slice(workingMerged.length);
          const rawAfter = [...rawMerged, ...newAssistantMessages];

          await db.session.update({
            where: { id, userId },
            data: {
              messages: rawAfter as unknown as Prisma.InputJsonValue,
              workingMessages: event.messages as unknown as Prisma.InputJsonValue,
              ...(compactionEvent
                ? {
                    compactionSummary: activeCompactionSummary,
                    compactionAt: new Date(),
                  }
                : {}),
            },
          });
        },
        onError(error) {
          // A stream that errors never reaches onFinish, so the reservation
          // has to be freed here too or it sits until the TTL expires.
          void releaseOnce();
          // Same protection as app.onError: a raw AI_APICallError.message can
          // include the full request body, which surfaces in the CLI as a
          // dump of the whole conversation.
          return safeErrorMessage(error, "Upstream model request failed");
        },
      });
    },
  );

export default app;
