/**
 * Session task lists, held CLI-side and persisted across restarts.
 *
 * ## Why the CLI owns this
 *
 * DarkCode's server is stateless — it builds a system prompt from whatever the
 * request carries and forgets everything afterwards. Session-local state
 * therefore lives here and travels up with each request, the same arrangement
 * `mcpTools` and `projectContext` already use.
 *
 * ## Why it is persisted rather than kept in memory
 *
 * Sessions can be resumed after the CLI exits. A task list that vanished on
 * restart would be worse than no task list at all: the system prompt reflects
 * the store, so the model would be *told* it has nothing outstanding and would
 * confidently declare finished work that is half done. State the model is
 * invited to trust must not silently reset.
 *
 * ## Shape of this file
 *
 * The decisions — validation, eviction, the single-in-progress rule — are pure
 * functions over plain data, and the filesystem work is a thin shell around
 * them. That split is what makes the interesting behaviour testable without
 * writing to anyone's home directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { todoListSchema, type Todo } from "@darkcode/shared";

/**
 * How many sessions' lists to keep on disk.
 *
 * The file is rewritten whole on every write, so it has to stay small. Oldest
 * first — a resumed session's list is re-saved on its first write, which moves
 * it back to the newest end and out of eviction range.
 */
export const MAX_RETAINED_SESSIONS = 50;

export type TodoStore = Record<string, Todo[]>;

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/**
 * Turn whatever was on disk into a store, dropping anything malformed.
 *
 * Validated on read, not only on write. The file is plain JSON in the user's
 * home directory, so it may have been hand-edited, half-written by a killed
 * process, or produced by an older version with a different shape. A bad entry
 * is dropped rather than allowed to reach the model, and one bad entry never
 * costs the others — this returns per-session results, not all-or-nothing.
 */
export function parseTodoStore(raw: unknown): TodoStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const store: TodoStore = {};
  for (const [sessionId, todos] of Object.entries(raw)) {
    const result = todoListSchema.safeParse(todos);
    if (result.success) store[sessionId] = result.data;
  }
  return store;
}

/**
 * Replace one session's list, returning a new store.
 *
 * Replace rather than merge, deliberately. The model re-sends the entire list
 * on every update, so stored state can never drift from what the model
 * believes it wrote — there is no partial update whose result depends on what
 * happened to be there already.
 */
export function applyTodoWrite(store: TodoStore, sessionId: string, todos: Todo[]): TodoStore {
  // Rebuild without the session first, so re-writing an existing session moves
  // it to the newest end of the insertion order instead of leaving it where it
  // was. Otherwise a long-running session that keeps updating its list would
  // still age out from under itself.
  const next: TodoStore = {};
  for (const [id, value] of Object.entries(store)) {
    if (id !== sessionId) next[id] = value;
  }
  next[sessionId] = todos;

  const ids = Object.keys(next);
  for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_RETAINED_SESSIONS))) {
    delete next[stale];
  }
  return next;
}

/**
 * Reject a list with more than one task in progress.
 *
 * This is the one rule the tool enforces rather than quietly normalizing, and
 * it is the rule that gives the list its meaning. A list where four things are
 * "in progress" records no more than a list with no statuses at all — the
 * point of the field is to name the single thing being worked on *now*, so
 * that the user, and a future compacted turn, can see where the work actually
 * is. Failing loudly costs one retry and says exactly what to change; silently
 * keeping the first would leave the model believing something the store does
 * not say.
 */
export function assertSingleInProgress(todos: Todo[]): void {
  const inProgress = todos.filter((t) => t.status === "in_progress");
  if (inProgress.length > 1) {
    throw new Error(
      `At most one task may be 'in_progress' (got ${inProgress.length}: ` +
        `${inProgress.map((t) => JSON.stringify(t.content)).join(", ")}). ` +
        `Mark the one you are actually working on now as 'in_progress' and leave the rest 'pending'.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Persistence shell
// ---------------------------------------------------------------------------

/**
 * Config directory. `DARKCODE_HOME` overrides it — used by the tests so they
 * never touch the developer's real `~/.darkcode`.
 */
function configDir(): string {
  return process.env.DARKCODE_HOME ?? join(homedir(), ".darkcode");
}

function todosFile(): string {
  return join(configDir(), "todos.json");
}

/**
 * In-process cache, so the common path — reading the list to attach it to an
 * outgoing request, which happens on every round trip including mid-turn tool
 * calls — does not hit the disk. `null` means "not loaded yet", which is
 * distinct from "loaded and empty".
 */
let cache: TodoStore | null = null;

function load(): TodoStore {
  if (cache) return cache;
  try {
    cache = parseTodoStore(JSON.parse(readFileSync(todosFile(), "utf-8")));
  } catch {
    // Missing or unreadable file is the normal first-run case.
    cache = {};
  }
  return cache;
}

/** The current list for a session. Empty when none has been written. */
export function getTodos(sessionId: string): Todo[] {
  return load()[sessionId] ?? [];
}

/** Replace a session's list, in memory and on disk. */
export function setTodos(sessionId: string, todos: Todo[]): Todo[] {
  const next = applyTodoWrite(load(), sessionId, todos);
  cache = next;

  try {
    const dir = configDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(todosFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch {
    // A read-only home should degrade to in-memory task lists for the rest of
    // the run, not fail the turn. `cache` is already updated.
  }
  return todos;
}

/** Drop the in-process cache so the next read re-reads the file. Test seam. */
export function __resetTodoCache(): void {
  cache = null;
}
