import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@darkcode/database/client";
import type { Prisma } from "@darkcode/database";
import type { UIMessage } from "ai";
import {
  BYOK_PROVIDERS,
  BYOK_PROVIDER_HEADER,
  DEFAULT_CHAT_MODEL_ID,
} from "@darkcode/shared";

import { logAuditEvent } from "../lib/audit";
import { compactWorkingContext } from "../lib/compaction";
import { calculateCreditsForUsage } from "../lib/credits";
import { ingestAiUsageWithOutbox } from "../lib/polar-outbox";
import { captureException } from "../lib/sentry";
import {
  ApiKeyRequiredError,
  isSupportedChatModel,
  resolveChatModel,
  type ProviderApiKeys,
} from "../lib/models";
import type { AuthenticatedEnv } from "../middleware/require-auth";


const createSessionSchema = z.object({
  title: z.string(),
});

const createSessionValidator = zValidator(
  "json", createSessionSchema, (result, c) => {
  if (!result.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

const app = new Hono<AuthenticatedEnv>()
  .get("/", async (c) => {
    const userId = c.get("userId");

    const rows = await db.session.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Shape matches the website's `SessionRecord` contract: a wrapped array
    // and `lastActivityAt` (which we source from Prisma's `updatedAt`).
    const sessions = rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      lastActivityAt: row.updatedAt.toISOString(),
    }));

    return c.json({ sessions });
  })
  .get("/:id", async (c) => {
    // MOCK: Uncomment to simulate slow session loading
    // await new Promise((r) => setTimeout(r, 5000))

    // MOCK: Uncomment to simulate session loading error
    // throw new HTTPException(
    //   500, 
    //   { message: "Mock error: session loading failed" }
    // )

    const id = c.req.param("id");
    const userId = c.get("userId");
    
    const session = await db.session.findUnique({
      where: { id, userId },
    });

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json(session);
  })
  .post("/", createSessionValidator, async (c) => {
    // MOCK: Uncomment to simulate slow session loading
    // await new Promise((r) => setTimeout(r, 5000))

    // MOCK: Uncomment to simulate session loading error
    // throw new HTTPException(
    //   500, 
    //   { message: "Mock error: session loading failed" }
    // )

    const userId = c.get("userId");
    const data = c.req.valid("json");

    const session = await db.session.create({
      data: {
        ...data,
        userId,
      },
    });

    void logAuditEvent({
      userId,
      action: "session.create",
      requestId: c.get("requestId"),
      metadata: { sessionId: session.id },
    });

    return c.json(session, 201);
  })
  .post(
    "/:id/compact",
    zValidator(
      "json",
      z
        .object({
          // Optional — when absent we fall back to the default chat model.
          // The summarizer call doesn't need the same model the session is
          // running on; the user might pick a cheap one to save credits.
          summarizerModel: z.string().optional(),
        })
        .partial()
        .optional()
        .default({}),
      (result, c) => {
        if (!result.success) {
          return c.json({ error: "Invalid request body" }, 400);
        }
      },
    ),
    async (c) => {
      const id = c.req.param("id");
      const userId = c.get("userId");
      const log = c.get("log");
      const body = c.req.valid("json") ?? {};

      const session = await db.session.findUnique({ where: { id, userId } });
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const rawWorking = (
        Array.isArray(session.workingMessages) && session.workingMessages.length > 0
          ? session.workingMessages
          : session.messages
      ) as unknown as UIMessage[];

      if (!Array.isArray(rawWorking) || rawWorking.length === 0) {
        return c.json({ error: "Nothing to compact" }, 400);
      }

      const summarizerId =
        body.summarizerModel && isSupportedChatModel(body.summarizerModel)
          ? body.summarizerModel
          : DEFAULT_CHAT_MODEL_ID;

      const apiKeys: ProviderApiKeys = {};
      for (const provider of BYOK_PROVIDERS) {
        const value = c.req.raw.headers.get(BYOK_PROVIDER_HEADER[provider]);
        if (value && value.length > 0) apiKeys[provider] = value;
      }

      let resolvedSummarizer;
      try {
        resolvedSummarizer = resolveChatModel(summarizerId, apiKeys);
      } catch (error) {
        if (error instanceof ApiKeyRequiredError) {
          return c.json(
            {
              error: `Missing ${error.provider} API key for summarizer. Pick a different model or run /keys.`,
              provider: error.provider,
            },
            400,
          );
        }
        throw error;
      }

      try {
        const result = await compactWorkingContext({
          rawWorkingMessages: rawWorking,
          pinnedMessageIds: session.pinnedMessageIds ?? [],
          previousSummary: session.compactionSummary ?? null,
          summarizerModel: resolvedSummarizer.model,
        });

        if (result.droppedCount === 0) {
          return c.json({
            compacted: false,
            droppedCount: 0,
            messageCount: rawWorking.length,
            summary: session.compactionSummary ?? null,
            summarizerModel: summarizerId,
            metered: resolvedSummarizer.isMetered,
          });
        }

        await db.session.update({
          where: { id, userId },
          data: {
            workingMessages: result.workingMessages as unknown as Prisma.InputJsonValue,
            compactionSummary: result.summary,
            compactionAt: new Date(),
          },
        });

        // Meter the summarizer call for hosted models — without this, /compact
        // on the default (hosted) model is unbilled API spend, same leak as the
        // per-turn compaction path in routes/chat.ts. BYOK summarizers bill
        // against the user's own key and are skipped.
        if (result.usage && resolvedSummarizer.isMetered) {
          try {
            const { credits } = calculateCreditsForUsage({
              provider: resolvedSummarizer.provider,
              model: resolvedSummarizer.modelId,
              usage: result.usage,
            });
            void ingestAiUsageWithOutbox({
              externalCustomerId: userId,
              eventId: `chat-compaction:${id}:${Date.now()}`,
              credits,
            });
          } catch (creditError) {
            log.error({ err: creditError, sessionId: id }, "session.compact_credit_calc_failed");
            captureException(creditError, {
              userId,
              requestId: c.get("requestId"),
              tags: { kind: "polar_compaction_credit_calc" },
              extra: { sessionId: id },
            });
          }
        }

        void logAuditEvent({
          userId,
          action: "session.compact",
          requestId: c.get("requestId"),
          metadata: { sessionId: id, droppedCount: result.droppedCount },
        });

        return c.json({
          compacted: true,
          droppedCount: result.droppedCount,
          messageCount: result.workingMessages.length,
          summary: result.summary,
          summarizerModel: summarizerId,
          metered: resolvedSummarizer.isMetered,
        });
      } catch (error) {
        log.error({ err: error, sessionId: id }, "session.compact_failed");
        return c.json({ error: "Compaction failed" }, 500);
      }
    },
  );

export default app;
