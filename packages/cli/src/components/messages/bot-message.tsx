import prettyMs from "pretty-ms";
import { EmptyBorder } from "../border";
import { useTheme } from "../../providers/theme";
import type { Message } from "../../hooks/use-chat";
import { Mode, getModelDisplayName, todoListSchema, type ModeType, type Todo } from "@darkcode/shared";
import { TextAttributes } from "@opentui/core";

type ClientMessagePart = Message["parts"][number];
type ToolPart = Extract<ClientMessagePart, { type: `tool-${string}` | "dynamic-tool" }>;

type Props = {
  parts: ClientMessagePart[];
  model: string;
  mode: ModeType;
  durationMs?: number;
  contextUsage?: { estimatedTokens: number; contextWindow: number };
  streaming?: boolean;
};

function formatContextPercent(usage: {
  estimatedTokens: number;
  contextWindow: number;
}): string {
  const pct = (usage.estimatedTokens / usage.contextWindow) * 100;
  return `${pct.toFixed(0)}%`;
}

function formatToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
};

function isToolPart(part: ClientMessagePart): part is ToolPart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
};

function formatToolArgs(tc: ToolPart): string {
  if (!("input" in tc) || tc.input == null) return "";
  if (typeof tc.input !== "object") return String(tc.input);
  return Object.values(tc.input).map(String).join(" ");
}

/**
 * Pull the task list out of a `todoWrite` call for rendering.
 *
 * Parsed rather than trusted: `input` is whatever the model streamed, and it
 * arrives *partial* while the call is still streaming — half an object, or a
 * `todos` array whose last element has no `status` yet. Validating means the
 * renderer either gets a well-formed list or falls back to the generic
 * one-liner, instead of throwing inside a render pass over a half-built object.
 */
function parseTodoInput(tc: ToolPart): Todo[] | null {
  if (!("input" in tc) || tc.input == null || typeof tc.input !== "object") return null;
  const todos = (tc.input as { todos?: unknown }).todos;
  const result = todoListSchema.safeParse(todos);
  return result.success ? result.data : null;
}

const TODO_GLYPH: Record<Todo["status"], string> = {
  completed: "✓",
  in_progress: "▸",
  pending: "○",
};

type PartGroup = {
  type: ClientMessagePart["type"];
  parts: ClientMessagePart[];
  key: string;
};

function groupConsecutiveParts(parts: ClientMessagePart[]): PartGroup[] {
  const groups: PartGroup[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const lastGroup = groups[groups.length - 1];

     if (lastGroup && lastGroup.type === part.type) {
      lastGroup.parts.push(part);
     } else {
      const key = 
        isToolPart(part) ? `group-tc-${part.toolCallId}` : `group-${part.type}-${i}`;
      groups.push({ type: part.type, parts: [part], key });
     }
  }

  return groups;
};

export function BotMessage({
  parts,
  model,
  mode,
  durationMs,
  contextUsage,
  streaming = false,
}: Props) {
  const { colors } = useTheme();
  const usagePercent = contextUsage
    ? contextUsage.estimatedTokens / contextUsage.contextWindow
    : null;
  // Theme doesn't currently expose warning/error colors; literal ANSI names
  // render correctly in OpenTUI and are stable across themes.
  const usageColor =
    usagePercent == null
      ? undefined
      : usagePercent >= 0.9
        ? "red"
        : usagePercent >= 0.75
          ? "yellow"
          : undefined;
  return (
    <box width="100%" alignItems="center">
      {groupConsecutiveParts(parts).map((group, i) => (
        <box key={group.key} width="100%" paddingTop={i === 0 ? 0 : 1}>
          {group.parts.map((part, j) => {
            if (part.type === "reasoning") {
              return (
                <box
                  key={`reasoning-${j}`}
                  border={["left"]}
                  borderColor={colors.thinkingBorder}
                  customBorderChars={{
                    ...EmptyBorder,
                    vertical: "│",
                  }}
                  width="100%"
                  paddingX={2}
                >
                  <text attributes={TextAttributes.DIM}>
                    <em fg={colors.thinking}>Thinking:</em> {part.text}
                  </text>
                </box>
              );
            }

            if (isToolPart(part)) {
              const toolName =
                part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);

              // The task list is the one tool whose argument *is* the result
              // worth seeing, so it gets a real rendering rather than the
              // generic "Tool: arg arg" line — which for this input would
              // stringify each task object to "[object Object]".
              const todos = toolName === "todoWrite" ? parseTodoInput(part) : null;
              if (todos) {
                return (
                  <box
                    key={part.toolCallId}
                    border={["left"]}
                    borderColor={colors.thinkingBorder}
                    customBorderChars={{ ...EmptyBorder, vertical: "│" }}
                    width="100%"
                    paddingX={2}
                  >
                    <text attributes={TextAttributes.DIM}>
                      <em fg={colors.info}>Todo:</em>{" "}
                      {todos.filter((t) => t.status === "completed").length}/{todos.length} done
                    </text>
                    {todos.map((todo, k) => (
                      <text
                        key={`todo-${part.toolCallId}-${k}`}
                        attributes={todo.status === "in_progress" ? undefined : TextAttributes.DIM}
                      >
                        <em
                          fg={
                            todo.status === "completed"
                              ? colors.success
                              : todo.status === "in_progress"
                                ? colors.info
                                : colors.dimSeparator
                          }
                        >
                          {"  "}
                          {TODO_GLYPH[todo.status]}
                        </em>{" "}
                        {todo.content}
                      </text>
                    ))}
                  </box>
                );
              }

              return (
                <box
                  key={part.toolCallId}
                  border={["left"]}
                  borderColor={colors.thinkingBorder}
                  customBorderChars={{
                    ...EmptyBorder,
                    vertical: "│",
                  }}
                  width="100%"
                  paddingX={2}
                >
                  <text attributes={TextAttributes.DIM}>
                    <em fg={colors.info}>{formatToolName(toolName)}:</em> {formatToolArgs(part)}
                    {part.state !== "output-available" && part.state !== "output-error" 
                      ? " …" 
                      : ""
                    }
                    {part.state === "output-error" ? ` ${part.errorText}` : ""}
                  </text>
                </box>
              );
            }

            if (part.type === "text") {
              return (
                <box key={`text-${j}`} paddingX={3} width="100%">
                  <text>{part.text}</text>
                </box>
              );
            }
            
            return null;
          })}
        </box>
      ))}

      <box paddingX={3} paddingY={1} gap={1} width="100%">
        <box flexDirection="row" gap={2}>
          <text fg={mode === Mode.PLAN ? colors.planMode : colors.primary}>◉</text>
          <box flexDirection="row" gap={1}>
            <text>
              {mode === Mode.PLAN ? "Plan" : "Build"}
            </text>
            <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
              ›
            </text>
            <text attributes={TextAttributes.DIM}>{getModelDisplayName(model)}</text>
            {(durationMs != null) && (
              <>
                <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
                  ›
                </text>
                <text attributes={TextAttributes.DIM}>
                  {prettyMs(durationMs)}
                </text>
              </>
            )}
            {contextUsage && (
              <>
                <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
                  ›
                </text>
                <text attributes={TextAttributes.DIM} fg={usageColor}>
                  ctx {formatContextPercent(contextUsage)}
                </text>
              </>
            )}
          </box>
        </box>
      </box>
    </box>
  );
};
