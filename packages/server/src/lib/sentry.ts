import * as Sentry from "@sentry/node";
import { logger } from "./logger";
import { env } from "./env";

let initialized = false;

export function initSentry() {
  if (initialized) return;
  if (!env.SENTRY_DSN) {
    logger.info("Sentry disabled (SENTRY_DSN not set)");
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: env.SENTRY_RELEASE,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
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
