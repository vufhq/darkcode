import * as Sentry from "@sentry/node";
import { logger } from "./logger";

let initialized = false;

export function initSentry() {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info("Sentry disabled (SENTRY_DSN not set)");
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
    sendDefaultPii: false,
  });

  initialized = true;
  logger.info("Sentry initialized");
}

export function captureException(
  error: unknown,
  context?: { userId?: string; requestId?: string; tags?: Record<string, string>; extra?: Record<string, unknown> },
) {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (context?.userId) scope.setUser({ id: context.userId });
    if (context?.requestId) scope.setTag("request_id", context.requestId);
    if (context?.tags) {
      for (const [key, value] of Object.entries(context.tags)) scope.setTag(key, value);
    }
    if (context?.extra) {
      for (const [key, value] of Object.entries(context.extra)) scope.setExtra(key, value);
    }
    Sentry.captureException(error);
  });
}

export { Sentry };
