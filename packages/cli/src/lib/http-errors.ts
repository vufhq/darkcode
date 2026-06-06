type ErrorResponse = {
  json: () => Promise<unknown>;
  status: number;
  statusText: string;
};

export async function getErrorMessage(response: ErrorResponse) {
  try {
    const data = (await response.json()) as { error?: string };
    if (typeof data.error === "string" && data.error.length > 0) {
      return data.error;
    }
  } catch {
    // Ignore invalid error payloads and fall back to the status text below.
  }

  return response.statusText || `Request failed with status ${response.status}`;
};

const MAX_CHAT_ERROR_LENGTH = 600;

export type ParsedChatError = {
  // Clean, length-capped, single-line message safe to render in the TUI.
  message: string;
  // Stable machine-readable code from the server body (e.g. "credits_depleted"),
  // when present. Drives actionable affordances without string-matching the
  // human-facing message.
  code?: string;
};

// `useChat` surfaces a non-2xx server response by throwing
// `new Error(await response.text())`, so `error.message` is the raw response
// BODY — typically `{"error":"…","code":"…","requestId":"…"}`. Unwrap the
// `error` field for a clean message, lift any `code`, and hard-cap the length:
// a server bug could otherwise put a huge string here (e.g. a leaked request
// body) and blow up the TUI viewport.
export function parseChatError(raw: string): ParsedChatError {
  let message = raw;
  let code: string | undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; code?: unknown };
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        message = parsed.error;
      }
      if (typeof parsed.code === "string" && parsed.code.length > 0) {
        code = parsed.code;
      }
    } catch {
      // Not JSON — fall through and use the raw string.
    }
  }

  const oneLine = message.split("\n")[0] ?? message;
  const capped =
    oneLine.length > MAX_CHAT_ERROR_LENGTH
      ? `${oneLine.slice(0, MAX_CHAT_ERROR_LENGTH)}…`
      : oneLine;
  return { message: capped, code };
};

// Back-compat thin wrapper: callers that only need the display string.
export function formatChatErrorMessage(raw: string): string {
  return parseChatError(raw).message;
};
