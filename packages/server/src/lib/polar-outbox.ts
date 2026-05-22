import { db } from "@darkcode/database/client";
import { ingestAiUsage } from "./polar";
import { logger } from "./logger";
import { captureException } from "./sentry";

const MAX_ATTEMPTS = 10;
const SWEEP_BATCH_SIZE = 50;
const SWEEP_INTERVAL_MS = 30_000;

type EnqueueArgs = {
  externalCustomerId: string;
  eventId: string;
  credits: number;
};

/**
 * Try ingesting inline; on failure, persist to the outbox so the sweeper
 * can retry. Returns true when ingest succeeded inline.
 */
export async function ingestAiUsageWithOutbox({
  externalCustomerId,
  eventId,
  credits,
}: EnqueueArgs): Promise<boolean> {
  if (credits <= 0) return true;
  try {
    await ingestAiUsage({ externalCustomerId, eventId, credits });
    return true;
  } catch (error) {
    logger.warn({ err: error, eventId }, "polar.ingest_failed.queuing_outbox");
    try {
      await db.polarIngestOutbox.create({
        data: {
          eventId,
          userId: externalCustomerId,
          credits,
          attempts: 1,
          lastAttempt: new Date(),
          lastError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        },
      });
    } catch (insertError) {
      // Most likely a unique-constraint hit (eventId already queued from a
      // previous failure). Safe to swallow — the sweeper will pick it up.
      logger.debug({ err: insertError, eventId }, "polar.outbox_insert_skipped");
    }
    captureException(error, {
      userId: externalCustomerId,
      tags: { kind: "polar_ingest_outbox_enqueue" },
      extra: { eventId, credits },
    });
    return false;
  }
}

function backoffMs(attempts: number) {
  // 2^n seconds, capped at 1 hour. Attempt 1 → 2s, 2 → 4s, ... 10 → 1024s.
  const seconds = Math.min(2 ** attempts, 3600);
  return seconds * 1000;
}

async function sweepOnce() {
  const now = new Date();
  const candidates = await db.polarIngestOutbox.findMany({
    where: {
      completedAt: null,
      attempts: { lt: MAX_ATTEMPTS },
    },
    orderBy: { createdAt: "asc" },
    take: SWEEP_BATCH_SIZE,
  });

  for (const row of candidates) {
    if (row.lastAttempt && row.lastAttempt.getTime() + backoffMs(row.attempts) > now.getTime()) {
      continue;
    }

    try {
      await ingestAiUsage({
        externalCustomerId: row.userId,
        eventId: row.eventId,
        credits: row.credits,
      });
      await db.polarIngestOutbox.update({
        where: { id: row.id },
        data: { completedAt: new Date(), lastError: null },
      });
      logger.info({ eventId: row.eventId, attempts: row.attempts + 1 }, "polar.outbox_drained");
    } catch (error) {
      const nextAttempts = row.attempts + 1;
      await db.polarIngestOutbox.update({
        where: { id: row.id },
        data: {
          attempts: nextAttempts,
          lastAttempt: new Date(),
          lastError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        },
      });
      if (nextAttempts >= MAX_ATTEMPTS) {
        logger.error({ eventId: row.eventId }, "polar.outbox_exhausted");
        captureException(error, {
          userId: row.userId,
          tags: { kind: "polar_ingest_outbox_exhausted" },
          extra: { eventId: row.eventId, credits: row.credits },
        });
      }
    }
  }
}

let sweeperTimer: ReturnType<typeof setInterval> | null = null;

export function startPolarOutboxSweeper() {
  if (sweeperTimer) return;
  // Fire-and-forget — never let a sweep failure crash the loop.
  sweeperTimer = setInterval(() => {
    sweepOnce().catch((error) => logger.error({ err: error }, "polar.outbox_sweep_failed"));
  }, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive solely for the sweeper.
  sweeperTimer.unref?.();
  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, "polar.outbox_sweeper_started");
}

export function stopPolarOutboxSweeper() {
  if (sweeperTimer) {
    clearInterval(sweeperTimer);
    sweeperTimer = null;
  }
}
