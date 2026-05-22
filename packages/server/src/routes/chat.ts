import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  convertToModelMessages,
  streamText,
  validateUIMessages,
  type InferUITools,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import { db } from "@darkcode/database/client";
import type { Prisma } from "@darkcode/database";
import {
  findSupportedChatModel,
  getToolContracts,
  modeSchema,
  type ModeType,
  type ToolContracts,
} from "@darkcode/shared";
import { buildSystemPrompt } from "../system-prompt";
import type { AuthenticatedEnv } from "../middleware/require-auth";
import { getAvailableCreditsBalance, ingestAiUsage } from "../lib/polar";
import { calculateCreditsForUsage } from "../lib/credits";
import {
  ApiKeyRequiredError,
  isSupportedChatModel,
  resolveChatModel,
  type ProviderApiKeys,
} from "../lib/models";

type ChatMessageMetadata = {
  mode?: ModeType;
  model?: string;
  durationMs?: number;
  usage?: LanguageModelUsage;
};

type DarkcodeUIMessage = UIMessage<ChatMessageMetadata, never, InferUITools<ToolContracts>>;

const submitSchema = z.object({
  id: z.string(),
  messages: z
    .array(
      z.custom<DarkcodeUIMessage>((value) => {
        return value != null && typeof value === "object" && "id" in value && "parts" in value;
      }),
    )
    .min(1),
  mode: modeSchema,
  model: z.string().refine(isSupportedChatModel, "Unsupported model"),
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

function readApiKeysFromHeaders(headers: Headers): ProviderApiKeys {
  const anthropic = headers.get("x-darkcode-anthropic-key") ?? undefined;
  const openai = headers.get("x-darkcode-openai-key") ?? undefined;
  return {
    anthropic: anthropic && anthropic.length > 0 ? anthropic : undefined,
    openai: openai && openai.length > 0 ? openai : undefined,
  };
}

const app = new Hono<AuthenticatedEnv>()
  .post(
    "/",
    submitValidator,
    async (c) => {
      const userId = c.get("userId");
      const { id, messages, mode, model } = c.req.valid("json");

      const modelDefinition = findSupportedChatModel(model);
      if (!modelDefinition) {
        return c.json({ error: "Unsupported model" }, 400);
      }

      // Only meter against DarkCode credits when the user is using a model we host.
      // BYOK models bill against the user's own provider account, so we skip the gate.
      if (!modelDefinition.requiresApiKey) {
        try {
          const creditsBalance = await getAvailableCreditsBalance(userId);
          if (creditsBalance <= 0) {
            return c.json(
              { error: "No credits remaining. Run /upgrade to buy more credits." },
              402,
            );
          }
        } catch {
          return c.json({ error: "Unable to verify credits balance right now." }, 503);
        }
      }

      const session = await db.session.findUnique({
        where: { id, userId },
      });

      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const startTime = Date.now();
      const tools = getToolContracts(mode);
      let resolvedModel;
      try {
        resolvedModel = resolveChatModel(model, readApiKeysFromHeaders(c.req.raw.headers));
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
        throw error;
      }
      const previousMessages = Array.isArray(session.messages)
        ? (session.messages as unknown as DarkcodeUIMessage[])
        : [];
      const mergedMessages = [...previousMessages];
      
      for (const message of messages) {
        const incomingMessage = {
          ...message,
          metadata: { ...message.metadata, mode, model },
        } satisfies DarkcodeUIMessage;

        const existingMessageIndex = mergedMessages.findIndex((m) => m.id === incomingMessage.id);

        if (existingMessageIndex === -1) {
          mergedMessages.push(incomingMessage);
        } else {
          mergedMessages[existingMessageIndex] = incomingMessage;
        }
      }

      const nextMessages = await validateUIMessages<DarkcodeUIMessage>({
        messages: mergedMessages,
        tools,
      });
      const modelMessages = await convertToModelMessages(nextMessages, { tools });
      let completedUsage: LanguageModelUsage | null = null;

      const result = streamText({
        model: resolvedModel.model,
        system: buildSystemPrompt({ mode, model }),
        messages: modelMessages,
        tools,
        providerOptions: resolvedModel.providerOptions,
        onFinish(event) {
          completedUsage = event.totalUsage;
        },
      });

      return result.toUIMessageStreamResponse<DarkcodeUIMessage>({
        originalMessages: nextMessages,
        messageMetadata({ part }) {
          if (part.type === "start") {
            return { mode, model };
          }

          if (part.type !== "finish") return undefined;

          return {
            mode,
            model,
            durationMs: Date.now() - startTime,
            ...(completedUsage ? { usage: completedUsage } : {}),
          };
        },
        async onFinish(event) {
          if (event.isAborted) return;

          if (hasPendingToolCalls(event.responseMessage)) return;

          await db.session.update({
            where: { id, userId },
            data: {
              messages: event.messages as unknown as Prisma.InputJsonValue,
            },
          });

          if (!completedUsage) return;
          // BYOK calls aren't billed through us, so don't ingest a Polar usage event.
          if (!resolvedModel.isMetered) return;

          try {
            const billableUsage = calculateCreditsForUsage({
              provider: resolvedModel.provider,
              model: resolvedModel.modelId,
              usage: completedUsage,
            });

            await ingestAiUsage({
              externalCustomerId: userId,
              eventId: `chat-message:${event.responseMessage.id}`,
              credits: billableUsage.credits,
            });
          } catch (error) {
            console.error("Failed to ingest Polar AI usage for chat message", {
              error,
              sessionId: id,
              messageId: event.responseMessage.id,
              userId,
            });
          }
        },
        onError(error) {
          return error instanceof Error ? error.message : String(error);
        },
      });
    },
  );

export default app;
