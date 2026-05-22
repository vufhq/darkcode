import * as Sentry from "@sentry/node";

let initialized = false;

export function initCliSentry() {
  if (initialized) return;
  const dsn = process.env.DARKCODE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.DARKCODE_VERSION,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });

  initialized = true;

  process.on("uncaughtException", (error) => {
    Sentry.captureException(error);
  });
  process.on("unhandledRejection", (reason) => {
    Sentry.captureException(reason);
  });
}

export function captureCliException(error: unknown, extra?: Record<string, unknown>) {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (extra) {
      for (const [key, value] of Object.entries(extra)) scope.setExtra(key, value);
    }
    Sentry.captureException(error);
  });
}
