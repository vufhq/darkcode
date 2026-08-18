import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { collectEnvironmentContext, collectInstructionFiles } from "./project-context";
import { MAX_INSTRUCTION_FILE_CHARS, MAX_INSTRUCTION_TOTAL_CHARS } from "@darkcode/shared";

const roots: string[] = [];

/** Create a throwaway project directory. `git` marks it as a repo root. */
async function makeProject(files: Record<string, string>, opts: { git?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "darkcode-ctx-"));
  roots.push(root);
  if (opts.git !== false) await mkdir(join(root, ".git"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

describe("collectInstructionFiles", () => {
  test("finds AGENTS.md at the project root", async () => {
    const root = await makeProject({ "AGENTS.md": "run bun test" });
    const files = await collectInstructionFiles(root);
    const project = files.filter((f) => !f.path.startsWith("~"));
    expect(project).toHaveLength(1);
    expect(project[0]!.path).toBe("AGENTS.md");
    expect(project[0]!.content).toBe("run bun test");
  });

  test("finds CLAUDE.md as well, AGENTS.md first", async () => {
    const root = await makeProject({ "AGENTS.md": "agents", "CLAUDE.md": "claude" });
    const project = (await collectInstructionFiles(root)).filter((f) => !f.path.startsWith("~"));
    expect(project.map((f) => f.path)).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  test("returns nothing when the project has no instruction files", async () => {
    const root = await makeProject({ "README.md": "hello" });
    expect((await collectInstructionFiles(root)).filter((f) => !f.path.startsWith("~"))).toEqual([]);
  });

  test("skips an empty or whitespace-only file", async () => {
    const root = await makeProject({ "AGENTS.md": "   \n\n  " });
    expect((await collectInstructionFiles(root)).filter((f) => !f.path.startsWith("~"))).toEqual([]);
  });

  test("orders outermost first so the nearest file wins", async () => {
    // Root and a nested package both carry conventions; the renderer presents
    // them in order and tells the model later entries are more specific.
    const root = await makeProject({
      "AGENTS.md": "root rules",
      "packages/cli/AGENTS.md": "cli rules",
    });
    const project = (await collectInstructionFiles(join(root, "packages", "cli"))).filter(
      (f) => !f.path.startsWith("~"),
    );
    expect(project.map((f) => f.path)).toEqual(["AGENTS.md", "packages/cli/AGENTS.md"]);
    expect(project.map((f) => f.content)).toEqual(["root rules", "cli rules"]);
  });

  test("uses forward slashes in display paths on every platform", async () => {
    const root = await makeProject({ "packages/cli/AGENTS.md": "x" });
    const project = (await collectInstructionFiles(join(root, "packages", "cli"))).filter(
      (f) => !f.path.startsWith("~"),
    );
    expect(project[0]!.path).toBe("packages/cli/AGENTS.md");
    expect(project[0]!.path).not.toContain("\\");
  });

  test("does not climb above the project root", async () => {
    // The parent of the repo root holds an AGENTS.md that must not be picked
    // up — otherwise a CLI started anywhere would inherit unrelated files.
    const outer = await makeProject({ "AGENTS.md": "OUTER" }, { git: false });
    await mkdir(join(outer, "inner", ".git"), { recursive: true });
    await writeFile(join(outer, "inner", "AGENTS.md"), "INNER", "utf-8");

    const project = (await collectInstructionFiles(join(outer, "inner"))).filter(
      (f) => !f.path.startsWith("~"),
    );
    expect(project.map((f) => f.content)).toEqual(["INNER"]);
  });

  test("without a repository, only the working directory is read", async () => {
    const root = await makeProject({ "AGENTS.md": "here", "sub/AGENTS.md": "sub" }, { git: false });
    const project = (await collectInstructionFiles(join(root, "sub"))).filter(
      (f) => !f.path.startsWith("~"),
    );
    expect(project.map((f) => f.content)).toEqual(["sub"]);
  });

  test("truncates a file over the per-file cap and flags it", async () => {
    const root = await makeProject({ "AGENTS.md": "x".repeat(MAX_INSTRUCTION_FILE_CHARS + 500) });
    const project = (await collectInstructionFiles(root)).filter((f) => !f.path.startsWith("~"));
    expect(project[0]!.content).toHaveLength(MAX_INSTRUCTION_FILE_CHARS);
    expect(project[0]!.truncated).toBe(true);
  });

  test("stops before exceeding the combined budget", async () => {
    // Two files that each fit alone but not together: the second is dropped
    // whole rather than cut mid-sentence. Note the per-file cap applies first,
    // so the first file contributes MAX_INSTRUCTION_FILE_CHARS, not its full
    // length — the second must be large enough to overflow what remains.
    const remaining = MAX_INSTRUCTION_TOTAL_CHARS - MAX_INSTRUCTION_FILE_CHARS;
    const root = await makeProject({
      "AGENTS.md": "y".repeat(MAX_INSTRUCTION_FILE_CHARS + 1_000),
      "CLAUDE.md": "z".repeat(remaining + 100),
    });
    const project = (await collectInstructionFiles(root)).filter((f) => !f.path.startsWith("~"));
    expect(project.map((f) => f.path)).toEqual(["AGENTS.md"]);
    const total = project.reduce((n, f) => n + f.content.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_INSTRUCTION_TOTAL_CHARS);
  });

  test("trims surrounding whitespace from file content", async () => {
    const root = await makeProject({ "AGENTS.md": "\n\n  use tabs  \n\n" });
    const project = (await collectInstructionFiles(root)).filter((f) => !f.path.startsWith("~"));
    expect(project[0]!.content).toBe("use tabs");
  });
});

describe("collectEnvironmentContext", () => {
  test("reports the working directory and platform", async () => {
    const root = await makeProject({});
    const env = await collectEnvironmentContext(root);
    expect(env.cwd).toBe(root);
    expect(env.platform).toBe(process.platform);
    expect(env.osVersion).toBeTruthy();
  });

  test("reports today's local date in ISO form", async () => {
    const env = await collectEnvironmentContext(await makeProject({}));
    expect(env.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}`;
    expect(env.date).toBe(expected);
  });

  test("reports whether bash is available", async () => {
    const env = await collectEnvironmentContext(await makeProject({}));
    expect(typeof env.bashAvailable).toBe("boolean");
    expect(env.bashAvailable).toBe(Bun.which("bash") !== null);
  });

  test("omits git context outside a repository", async () => {
    // A bare `.git` directory with no objects is not a working tree, and a
    // temp dir has no repo at all.
    const env = await collectEnvironmentContext(await makeProject({}, { git: false }));
    expect(env.git).toBeUndefined();
  });

  test("reports git state inside this repository", async () => {
    // Runs against the darkcode checkout itself, which is a real repo.
    const env = await collectEnvironmentContext(process.cwd());
    expect(env.git).toBeDefined();
    expect(typeof env.git!.head).toBe("string");
    expect(typeof env.git!.dirtyCount).toBe("number");
  });

  test("satisfies the shared schema", async () => {
    const { environmentContextSchema } = await import("@darkcode/shared");
    const env = await collectEnvironmentContext(process.cwd());
    expect(environmentContextSchema.safeParse(env).success).toBe(true);
  });
});
