import { z } from "zod";

/**
 * The session task list.
 *
 * The model plans multi-step work by writing a list of tasks and marking one
 * of them in progress. Two properties make this worth having a tool for,
 * rather than letting the model track its plan in prose:
 *
 * 1. **It survives compaction.** Prose plans live in the message history, and
 *    compaction drops message history — which is precisely when a long task
 *    is most at risk of losing its thread. The list travels in the system
 *    prompt instead (see `renderTodos` in the server), so it is re-stated on
 *    every single request and the compaction pass cannot take it away.
 * 2. **It is structured, so the UI can render it.** A plan buried in an
 *    assistant message is invisible; a list with statuses can be shown to the
 *    user as progress.
 *
 * The state lives CLI-side, like every other piece of session-local state, and
 * is sent up with each request. The server never stores it.
 */

/** Hard ceiling on tasks per list. */
export const MAX_TODOS = 50;
/** Hard ceiling on one task's text, in characters. */
export const MAX_TODO_CONTENT_CHARS = 200;

export const todoStatusSchema = z.enum(["pending", "in_progress", "completed"]);

export const todoSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(MAX_TODO_CONTENT_CHARS)
    .describe("The task, phrased as a short imperative — e.g. 'Add regression test for CRLF files'"),
  status: todoStatusSchema.describe(
    "One of 'pending', 'in_progress', or 'completed'. At most one task may be 'in_progress'.",
  ),
});

export const todoListSchema = z.array(todoSchema).max(MAX_TODOS);

export type TodoStatus = z.infer<typeof todoStatusSchema>;
export type Todo = z.infer<typeof todoSchema>;

/** Counts by status, used for both the tool result and the UI. */
export function summarizeTodos(todos: Todo[]): {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
} {
  return {
    total: todos.length,
    pending: todos.filter((t) => t.status === "pending").length,
    inProgress: todos.filter((t) => t.status === "in_progress").length,
    completed: todos.filter((t) => t.status === "completed").length,
  };
}
