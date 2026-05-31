import type { UIMessage } from "ai";

// 4 chars/token is the widely used rough heuristic for English-ish content
// (OpenAI's docs cite ~3.5–4). It overestimates for code (more punctuation,
// fewer dictionary words) which is the safe direction for a *threshold* check
// — we'd rather compact one turn early than blow the window.
//
// Real billing still flows through provider-reported `usage` in chat.ts; this
// estimator only gates compaction triggers.
const CHARS_PER_TOKEN = 4;

function estimateStringTokens(value: string): number {
  return Math.ceil(value.length / CHARS_PER_TOKEN);
}

function estimateUnknownTokens(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return estimateStringTokens(value);
  try {
    return estimateStringTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

// Estimate token count for a single UIMessage by walking its `parts`. We
// charge text content directly; tool calls charge both their input args and
// their output payload, since both go on the wire to the model.
export function estimateMessageTokens(message: UIMessage): number {
  let total = 0;
  for (const part of message.parts) {
    if (part.type === "text") {
      total += estimateStringTokens(part.text ?? "");
      continue;
    }
    if (part.type === "reasoning") {
      total += estimateStringTokens((part as { text?: string }).text ?? "");
      continue;
    }
    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      const p = part as { input?: unknown; output?: unknown };
      total += estimateUnknownTokens(p.input);
      total += estimateUnknownTokens(p.output);
      continue;
    }
    // Fallback for unknown part shapes — keep the estimate from going to zero.
    total += estimateUnknownTokens(part);
  }
  return total;
}

export function estimateMessagesTokens(messages: UIMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

// Reserve for the assistant's response so we don't compact only to immediately
// blow the window again on the model's reply.
export const RESPONSE_TOKEN_RESERVE = 4096;

export type ProjectionInput = {
  systemPrompt: string;
  workingMessages: UIMessage[];
  incomingMessages: UIMessage[];
};

export function projectNextRequestTokens(input: ProjectionInput): number {
  return (
    estimateStringTokens(input.systemPrompt) +
    estimateMessagesTokens(input.workingMessages) +
    estimateMessagesTokens(input.incomingMessages) +
    RESPONSE_TOKEN_RESERVE
  );
}
