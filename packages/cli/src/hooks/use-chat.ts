import { useEffect, useMemo, useRef, useState } from "react";
import { useChat as useAiChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  type InferUITools,
  lastAssistantMessageIsCompleteWithToolCalls,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import {
  BYOK_PROVIDERS,
  BYOK_PROVIDER_HEADER,
  type ModeType,
  type ProjectContext,
  type SupportedChatModelId,
  type ToolContracts,
} from "@darkcode/shared";
import { apiClient } from "../lib/api-client";
import { getAuth } from "../lib/auth";
import { getAllApiKeys } from "../lib/api-keys";
import { executeLocalTool } from "../lib/local-tools";
import { captureCliException } from "../lib/sentry";
import {
  MCP_TOOL_NAME_PREFIX,
  callMcpTool,
  discoverAllMcpTools,
  type McpToolDescriptor,
} from "../lib/mcp";
import { checkPermission, PermissionDeniedError } from "../lib/permissions/engine";
import { collectProjectContext } from "../lib/project-context";
import { getTodos } from "../lib/todos";

export type ChatMessageMetadata = {
  mode?: ModeType;
  model?: SupportedChatModelId | string;
  durationMs?: number;
  usage?: LanguageModelUsage;
  // Present on the assistant message returned from a turn that ran
  // compaction. CLI renders a `CompactionDivider` ahead of the message.
  compaction?: {
    droppedCount: number;
    summary: string;
  };
  // Snapshot of token utilization for the just-completed request, used to
  // drive the per-turn context-usage indicator in the BotMessage footer.
  contextUsage?: {
    estimatedTokens: number;
    contextWindow: number;
  };
};

type ChatTools = {
  [Name in keyof InferUITools<ToolContracts>]: {
    input: InferUITools<ToolContracts>[Name]["input"];
    output: unknown;
  };
};

export type Message = UIMessage<ChatMessageMetadata, never, ChatTools>;

export function useChat(sessionId: string, initialMessages: Message[]) {
  // MCP tools advertised in each chat request. Discovered once per CLI
  // session — M2 will subscribe to `notifications/tools/list_changed` for
  // hot updates. Held in a ref so the transport's `prepareSendMessagesRequest`
  // (which is created once via useMemo) can read the latest value without
  // re-creating the transport on every discovery.
  const mcpToolsRef = useRef<McpToolDescriptor[]>([]);
  const [, setMcpToolsTick] = useState(0);

  // Machine + project context (cwd, platform, git state, AGENTS.md /
  // CLAUDE.md). Held in a ref for the same reason as `mcpTools`:
  // `prepareSendMessagesRequest` is synchronous, so it can only read an
  // already-resolved value. Refreshed before each user turn so git state stays
  // current, and deliberately NOT refreshed between tool round-trips within a
  // turn — the model should see one consistent view of the world per turn.
  const projectContextRef = useRef<ProjectContext | null>(null);

  const refreshProjectContext = useRef(async () => {
    try {
      projectContextRef.current = await collectProjectContext();
    } catch (error) {
      // Context is an enhancement, never a precondition for chatting.
      captureCliException(error, { kind: "project_context" });
    }
  }).current;

  useEffect(() => {
    void refreshProjectContext();
  }, [refreshProjectContext, sessionId]);

  useEffect(() => {
    let cancelled = false;
    void discoverAllMcpTools()
      .then((tools) => {
        if (cancelled) return;
        mcpToolsRef.current = tools;
        // Bump a counter so React knows discovery resolved — useful for any
        // future UI that wants to render the catalog.
        setMcpToolsTick((n) => n + 1);
      })
      .catch((error) => {
        captureCliException(error, { sessionId, kind: "mcp_discovery" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

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
        for (const provider of BYOK_PROVIDERS) {
          const key = apiKeys[provider];
          if (key) {
            headers.set(BYOK_PROVIDER_HEADER[provider], key);
          }
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

        const mcpTools = mcpToolsRef.current;
        const todos = getTodos(sessionId);

        return {
          body: {
            id: sessionId,
            messages: requestMessages,
            mode: message.metadata?.mode ?? metadata?.mode,
            model: message.metadata?.model ?? metadata?.model,
            ...(mcpTools.length > 0
              ? {
                  mcpTools: mcpTools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema,
                  })),
                }
              : {}),
            ...(projectContextRef.current ? { projectContext: projectContextRef.current } : {}),
            // Read at send time, not turn start. `todoWrite` runs mid-turn as
            // a tool call, and the very next request in the same turn must
            // carry the updated list — otherwise the model would mark a task
            // in progress and immediately be shown a prompt saying it hadn't.
            ...(todos.length > 0 ? { todos } : {}),
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
      const isMcp = toolCall.toolName.startsWith(MCP_TOOL_NAME_PREFIX);

      // Built-in tools run their own permission check inside `executeLocalTool`
      // (bash / writeFile / editFile). MCP tools aren't wired through that
      // dispatcher, so we gate them here before calling the host.
      const dispatch = isMcp
        ? (async () => {
            await checkPermission({
              kind: "mcp",
              toolName: toolCall.toolName,
              args: toolCall.input,
            });
            return callMcpTool(toolCall.toolName, toolCall.input);
          })()
        : executeLocalTool(toolCall.toolName, toolCall.input, mode, sessionId);

      void dispatch
        .then((output) =>
          chat.addToolOutput({
            tool: toolCall.toolName as keyof ChatTools,
            toolCallId: toolCall.toolCallId,
            output,
          }),
        )
        .catch((error) => {
          // PermissionDeniedError is expected user signal, not a CLI bug —
          // surface it back to the model as a tool error without telemetry.
          if (!(error instanceof PermissionDeniedError)) {
            captureCliException(error, {
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              sessionId,
            });
          }
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
    submit: async (params: { userText: string; mode: ModeType; model: SupportedChatModelId }) => {
      // Re-read the environment before the turn so the model sees the current
      // branch and working-tree state rather than whatever was true when the
      // session opened.
      await refreshProjectContext();
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
