// Build a *safe* user-facing error string. The Vercel AI SDK's
// `AI_APICallError.message` field often contains the entire upstream
// request body (system prompt + every message + every tool output). If we
// pass that straight to the CLI, the user sees their whole conversation
// dumped back at them in red. This helper extracts a short, useful summary
// without leaking the request.

const MAX_LENGTH = 400;

function clip(value: string): string {
  const oneLine = value.split("\n")[0] ?? value;
  return oneLine.length > MAX_LENGTH ? `${oneLine.slice(0, MAX_LENGTH)}…` : oneLine;
}

type MaybeApiCallError = {
  name?: unknown;
  statusCode?: unknown;
  responseBody?: unknown;
  message?: unknown;
};

function readUpstreamMessage(body: unknown): string | null {
  if (body == null) return null;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      return readUpstreamMessage(parsed);
    } catch {
      return clip(body);
    }
  }
  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    // Anthropic: { type: "error", error: { type, message } }
    // OpenAI:    { error: { message, type } }
    const nested = obj.error;
    if (nested && typeof nested === "object" && "message" in nested) {
      const m = (nested as { message?: unknown }).message;
      if (typeof m === "string" && m.length > 0) return clip(m);
    }
    if (typeof obj.message === "string" && obj.message.length > 0) {
      return clip(obj.message);
    }
  }
  return null;
}

export function safeErrorMessage(error: unknown, fallback: string): string {
  if (error == null) return fallback;

  // Try to surface a clean upstream error first, regardless of error class.
  if (typeof error === "object") {
    const e = error as MaybeApiCallError;
    if (e.name === "AI_APICallError") {
      const upstream = readUpstreamMessage(e.responseBody);
      const status = typeof e.statusCode === "number" ? ` (${e.statusCode})` : "";
      return upstream
        ? `${fallback}${status}: ${upstream}`
        : `${fallback}${status}`;
    }
  }

  if (error instanceof Error) {
    // For everything else, take only the first line and cap the length so
    // long stack-trace-style messages can't blow up the CLI viewport.
    return clip(error.message || fallback);
  }

  return clip(String(error));
}
