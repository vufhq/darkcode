import { useMemo } from "react";
import { useChat as useAiChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  type InferUITools,
  lastAssistantMessageIsCompleteWithToolCalls,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import { type ModeType, type SupportedChatModelId, type ToolContracts } from "@darkcode/shared";
import { apiClient } from "../lib/api-client";
import { getAuth } from "../lib/auth";
import { getAllApiKeys } from "../lib/api-keys";
import { executeLocalTool } from "../lib/local-tools";
import { captureCliException } from "../lib/sentry";

export type ChatMessageMetadata = {
  mode?: ModeType;
  model?: SupportedChatModelId | string;
  durationMs?: number;
  usage?: LanguageModelUsage;
};

type ChatTools = {
  [Name in keyof InferUITools<ToolContracts>]: {
    input: InferUITools<ToolContracts>[Name]["input"];
    output: unknown;
  };
};

export type Message = UIMessage<ChatMessageMetadata, never, ChatTools>;

export function useChat(sessionId: string, initialMessages: Message[]) {
  const transport = useMemo(() => {
    return new DefaultChatTransport<Message>({
      api: apiClient.chat.$url().toString(),
      headers() {
        const auth = getAuth();
        const headers = new Headers();
        if (auth) {
          headers.set("Authorization", `Bearer ${auth.token}`);
        }
        // Forward locally stored BYOK keys for non-DarkCode models. The server
        // ignores them when using the hosted model, so it's safe to always send.
        const apiKeys = getAllApiKeys();
        if (apiKeys.anthropic) {
          headers.set("x-darkcode-anthropic-key", apiKeys.anthropic);
        }
        if (apiKeys.openai) {
          headers.set("x-darkcode-openai-key", apiKeys.openai);
        }
        return headers;
      },
      prepareSendMessagesRequest({ messages }) {
        const message = messages[messages.length - 1];
        if (!message) throw new Error("No message to send");

        const metadata = messages.findLast(
          (m) => m.metadata?.mode && m.metadata?.model,
        )?.metadata;
        const previousMessage = messages[messages.length - 2];
        const requestMessages =
          message.role === "assistant" && previousMessage?.role === "user"
            ? [previousMessage, message]
            : [message];

        return {
          body: {
            id: sessionId,
            messages: requestMessages,
            mode: message.metadata?.mode ?? metadata?.mode,
            model: message.metadata?.model ?? metadata?.model,
          },
        }
      }
    });
  }, [sessionId]);

  const chat = useAiChat<Message>({
    id: sessionId,
    messages: initialMessages,
    transport,
    onToolCall({ toolCall }) {
      const mode = chat.messages.at(-1)?.metadata?.mode ?? "BUILD";

      void executeLocalTool(toolCall.toolName, toolCall.input, mode)
        .then((output) =>
          chat.addToolOutput({
            tool: toolCall.toolName as keyof ChatTools,
            toolCallId: toolCall.toolCallId,
            output,
          }),
        )
        .catch((error) => {
          captureCliException(error, {
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            sessionId,
          });
          chat.addToolOutput({
            tool: toolCall.toolName as keyof ChatTools,
            toolCallId: toolCall.toolCallId,
            state: "output-error",
            errorText: error instanceof Error ? error.message : String(error),
          });
        });
    },
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  return {
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    submit: (params: { userText: string; mode: ModeType; model: SupportedChatModelId }) => {
      return chat.sendMessage({
        text: params.userText,
        metadata: {
          mode: params.mode,
          model: params.model,
        },
      })
    },
    abort: chat.stop,
    interrupt: chat.stop,
  };
};
