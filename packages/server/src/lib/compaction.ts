import {
  generateText,
  type LanguageModel,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";

// How many trailing UIMessages stay verbatim. Counts every message (user +
// assistant + tool), not turn pairs, so the practical floor is ~5 exchanges.
const DEFAULT_RECENT_MESSAGES = 10;

export type CompactionInput = {
  rawWorkingMessages: UIMessage[];
  pinnedMessageIds: string[];
  // Previous digest, if any — folded into the new one so the chain stays
  // coherent across repeated compactions.
  previousSummary: string | null;
  // Model used to write the digest. First cut reuses the session's active
  // model; a follow-up can route this to a cheaper summarizer.
  summarizerModel: LanguageModel;
  recentMessages?: number;
  // Aborts the summarizer call when the request is cancelled or the turn's
  // timeout budget is exhausted. Optional so non-request callers (e.g. tests)
  // can omit it.
  abortSignal?: AbortSignal;
};

export type CompactionResult = {
  workingMessages: UIMessage[];
  summary: string;
  // How many messages from the old range were folded into the digest.
  droppedCount: number;
  // Token usage of the summarizer call, so the caller can meter it when the
  // summarizer is a hosted (billed) model. Null when no summarization ran.
  usage: LanguageModelUsage | null;
};

// Render a single UIMessage as plain text for the summarizer. We don't try to
// preserve structure — the digest is prose, not a transcript.
function renderMessage(message: UIMessage): string {
  const lines: string[] = [`[${message.role}]`];
  for (const part of message.parts) {
    if (part.type === "text") {
      lines.push((part as { text?: string }).text ?? "");
      continue;
    }
    if (part.type === "reasoning") {
      lines.push(`(reasoning) ${(part as { text?: string }).text ?? ""}`);
      continue;
    }
    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      const p = part as { type: string; input?: unknown; output?: unknown };
      const toolName = p.type.startsWith("tool-") ? p.type.slice(5) : "tool";
      const input = safeStringify(p.input);
      const output = safeStringify(p.output);
      lines.push(`(tool ${toolName}) input=${input} output=${output}`);
      continue;
    }
  }
  return lines.join("\n");
}

function safeStringify(value: unknown): string {
  if (value == null) return "";
  try {
    const json = JSON.stringify(value);
    return json.length > 2000 ? `${json.slice(0, 2000)}…` : json;
  } catch {
    return "";
  }
}

const SUMMARIZER_INSTRUCTIONS = `You are summarizing an in-progress coding-agent conversation so it survives context compaction.

Produce a structured digest with these sections (use markdown headings):
- **Decisions made** — concrete choices the user and agent committed to.
- **Files touched** — paths edited or created, with a one-line note each.
- **Open threads** — questions, blockers, or follow-ups still outstanding.
- **Unresolved errors** — failures the agent hit and has not yet fixed.

Be terse. Bullet points, no narration. Omit any section that has no content.
Keep total length under ~600 words.`;

// Compact the working context. Returns a new `workingMessages` array
// containing only the trailing window (and pinned messages, if any) plus the
// digest (which the caller injects into the system prompt — not into the
// message array, so it survives the next compaction pass).
export async function compactWorkingContext(
  input: CompactionInput,
): Promise<CompactionResult> {
  const {
    rawWorkingMessages,
    pinnedMessageIds,
    previousSummary,
    summarizerModel,
    recentMessages = DEFAULT_RECENT_MESSAGES,
    abortSignal,
  } = input;

  if (rawWorkingMessages.length <= recentMessages) {
    return {
      workingMessages: rawWorkingMessages,
      summary: previousSummary ?? "",
      droppedCount: 0,
      usage: null,
    };
  }

  // Keep the trailing `recentMessages`, then snap the cutoff *backward* to the
  // start of a turn (a `user` message). A window that begins on an assistant
  // or tool message orphans it from the user turn that prompted it, which
  // convertToModelMessages / the provider can reject (Anthropic, for one,
  // requires the first message to be `user`). Snapping back keeps a few extra
  // messages but guarantees the retained window is a sequence of whole turns.
  let cutoff = rawWorkingMessages.length - recentMessages;
  while (cutoff > 0 && rawWorkingMessages[cutoff]?.role !== "user") {
    cutoff--;
  }

  // If there's no earlier turn boundary, there's nothing safe to drop.
  if (cutoff <= 0) {
    return {
      workingMessages: rawWorkingMessages,
      summary: previousSummary ?? "",
      droppedCount: 0,
      usage: null,
    };
  }

  const oldRange = rawWorkingMessages.slice(0, cutoff);
  const tail = rawWorkingMessages.slice(cutoff);

  // Pinned messages from the old range stay in the working context. Insert
  // them just before the tail, preserving their relative order.
  const pinnedSet = new Set(pinnedMessageIds);
  const preservedPins = oldRange.filter((m) => pinnedSet.has(m.id));
  const droppedForSummary = oldRange.filter((m) => !pinnedSet.has(m.id));

  const renderedHistory = droppedForSummary.map(renderMessage).join("\n\n");
  const priorSection = previousSummary
    ? `Previous digest (fold into the new one — do not just repeat it):\n${previousSummary}\n\n`
    : "";

  const { text, usage } = await generateText({
    model: summarizerModel,
    system: SUMMARIZER_INSTRUCTIONS,
    prompt: `${priorSection}Conversation to summarize:\n\n${renderedHistory}`,
    abortSignal,
  });

  return {
    workingMessages: [...preservedPins, ...tail],
    summary: text.trim(),
    droppedCount: droppedForSummary.length,
    usage,
  };
}
