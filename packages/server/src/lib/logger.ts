import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  base: { service: "darkcode-server" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-darkcode-anthropic-key']",
      "req.headers['x-darkcode-openai-key']",
      "*.apiKey",
      "*.api_key",
      "*.password",
      "*.secret",
    ],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
