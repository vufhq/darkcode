import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Todo } from "@darkcode/shared";

import {
  MAX_RETAINED_SESSIONS,
  __resetTodoCache,
  applyTodoWrite,
  assertSingleInProgress,
  getTodos,
  parseTodoStore,
  setTodos,
  type TodoStore,
} from "./todos";

const todo = (content: string, status: Todo["status"] = "pending"): Todo => ({ content, status });

// -----------------------------------------------------------------------------
// Pure core — no filesystem involved.
// -----------------------------------------------------------------------------

describe("assertSingleInProgress", () => {
  test("allows a list with exactly one task in progress", () => {
    expect(() =>
      assertSingleInProgress([todo("a", "completed"), todo("b", "in_progress"), todo("c")]),
    ).not.toThrow();
  });

  test("allows a list with none in progress", () => {
    expect(() => assertSingleInProgress([todo("a"), todo("b", "completed")])).not.toThrow();
  });

  test("allows an empty list", () => {
    expect(() => assertSingleInProgress([])).not.toThrow();
  });

  test("rejects two tasks in progress", () => {
    expect(() =>
      assertSingleInProgress([todo("a", "in_progress"), todo("b", "in_progress")]),
    ).toThrow(/At most one task/);
  });

  test("names the offending tasks so the model can fix it in one retry", () => {
    // A bare "invalid input" would cost a guess; the message has to say which.
    expect(() =>
      assertSingleInProgress([todo("write tests", "in_progress"), todo("ship it", "in_progress")]),
    ).toThrow(/"write tests".*"ship it"/);
  });
});

describe("parseTodoStore", () => {
  test("returns an empty store for non-object input", () => {
    expect(parseTodoStore(null)).toEqual({});
    expect(parseTodoStore("nonsense")).toEqual({});
    expect(parseTodoStore([1, 2, 3])).toEqual({});
  });

  test("keeps well-formed sessions", () => {
    const raw = { s1: [{ content: "a", status: "pending" }] };
    expect(parseTodoStore(raw)).toEqual({ s1: [todo("a")] });
  });

  test("drops only the malformed session, not its neighbours", () => {
    // One corrupt entry must not cost the user every other session's list.
    const raw = {
      good: [{ content: "a", status: "pending" }],
      bad: [{ content: "b", status: "halfway" }],
      alsoGood: [{ content: "c", status: "completed" }],
    };
    expect(Object.keys(parseTodoStore(raw)).sort()).toEqual(["alsoGood", "good"]);
  });

  test("drops an entry whose value is not a list at all", () => {
    expect(parseTodoStore({ s1: "not a list" })).toEqual({});
  });

  test("drops a task with empty content", () => {
    expect(parseTodoStore({ s1: [{ content: "", status: "pending" }] })).toEqual({});
  });
});

describe("applyTodoWrite", () => {
  test("adds a session's list", () => {
    expect(applyTodoWrite({}, "s1", [todo("a")])).toEqual({ s1: [todo("a")] });
  });

  test("replaces rather than merges", () => {
    const store: TodoStore = { s1: [todo("old"), todo("older")] };
    expect(applyTodoWrite(store, "s1", [todo("new")])).toEqual({ s1: [todo("new")] });
  });

  test("does not mutate the store it was given", () => {
    const store: TodoStore = { s1: [todo("a")] };
    applyTodoWrite(store, "s1", [todo("b")]);
    expect(store).toEqual({ s1: [todo("a")] });
  });

  test("leaves other sessions untouched", () => {
    const store: TodoStore = { s1: [todo("a")], s2: [todo("b")] };
    expect(applyTodoWrite(store, "s1", [todo("c")])).toEqual({ s1: [todo("c")], s2: [todo("b")] });
  });

  test("accepts an empty list as a legitimate clear", () => {
    expect(applyTodoWrite({ s1: [todo("a")] }, "s1", [])).toEqual({ s1: [] });
  });

  test("evicts the oldest sessions past the retention cap", () => {
    let store: TodoStore = {};
    for (let i = 0; i < MAX_RETAINED_SESSIONS + 5; i++) {
      store = applyTodoWrite(store, `s${i}`, [todo(`task ${i}`)]);
    }
    const ids = Object.keys(store);
    expect(ids).toHaveLength(MAX_RETAINED_SESSIONS);
    expect(ids).not.toContain("s0");
    expect(ids).toContain(`s${MAX_RETAINED_SESSIONS + 4}`);
  });

  test("re-writing a session refreshes its position, so it is not evicted", () => {
    // Otherwise a long session that keeps updating its list would age out from
    // under itself while still being the one in active use.
    let store: TodoStore = applyTodoWrite({}, "long-running", [todo("start")]);
    for (let i = 0; i < MAX_RETAINED_SESSIONS - 1; i++) {
      store = applyTodoWrite(store, `other${i}`, [todo("x")]);
      store = applyTodoWrite(store, "long-running", [todo(`step ${i}`)]);
    }
    expect(Object.keys(store)).toContain("long-running");
  });
});

// -----------------------------------------------------------------------------
// Persistence shell — against a throwaway DARKCODE_HOME.
// -----------------------------------------------------------------------------

describe("persistence", () => {
  let dir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.DARKCODE_HOME;
    dir = mkdtempSync(join(tmpdir(), "darkcode-todos-"));
    process.env.DARKCODE_HOME = dir;
    __resetTodoCache();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.DARKCODE_HOME;
    else process.env.DARKCODE_HOME = previousHome;
    __resetTodoCache();
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads back an empty list for an unknown session", () => {
    expect(getTodos("never-written")).toEqual([]);
  });

  test("round-trips through the file, not just the cache", () => {
    // Dropping the cache is the point: this proves the list survives a restart,
    // which is the whole reason it is persisted at all.
    setTodos("s1", [todo("a", "in_progress"), todo("b")]);
    __resetTodoCache();
    expect(getTodos("s1")).toEqual([todo("a", "in_progress"), todo("b")]);
  });

  test("creates the config directory when it does not exist", () => {
    process.env.DARKCODE_HOME = join(dir, "nested", "deeper");
    __resetTodoCache();
    setTodos("s1", [todo("a")]);
    expect(JSON.parse(readFileSync(join(dir, "nested", "deeper", "todos.json"), "utf-8"))).toEqual({
      s1: [todo("a")],
    });
  });

  test("survives a corrupt file rather than throwing on the next turn", () => {
    writeFileSync(join(dir, "todos.json"), "{ this is not json");
    __resetTodoCache();
    expect(getTodos("s1")).toEqual([]);
    // And a write repairs it.
    setTodos("s1", [todo("a")]);
    __resetTodoCache();
    expect(getTodos("s1")).toEqual([todo("a")]);
  });

  test("keeps sessions separate", () => {
    setTodos("s1", [todo("one")]);
    setTodos("s2", [todo("two")]);
    __resetTodoCache();
    expect(getTodos("s1")).toEqual([todo("one")]);
    expect(getTodos("s2")).toEqual([todo("two")]);
  });
});
