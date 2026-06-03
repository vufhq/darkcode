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

// `useChat` surfaces a non-2xx server response by throwing
// `new Error(await response.text())`, so `error.message` is the raw response
// BODY — typically `{"error":"…","requestId":"…"}`. Unwrap the `error` field for
// a clean message and hard-cap the length: a server bug could otherwise put a
// huge string here (e.g. a leaked request body) and blow up the TUI viewport.
export function formatChatErrorMessage(raw: string): string {
  let message = raw;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        message = parsed.error;
      }
    } catch {
      // Not JSON — fall through and use the raw string.
    }
  }

  const oneLine = message.split("\n")[0] ?? message;
  return oneLine.length > MAX_CHAT_ERROR_LENGTH
    ? `${oneLine.slice(0, MAX_CHAT_ERROR_LENGTH)}…`
    : oneLine;
};
