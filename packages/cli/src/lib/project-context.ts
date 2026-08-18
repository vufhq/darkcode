import { readFile, stat } from "fs/promises";
import { homedir, release, type as osType } from "os";
import { dirname, join, relative, sep } from "path";
import {
  MAX_INSTRUCTION_FILES,
  MAX_INSTRUCTION_FILE_CHARS,
  MAX_INSTRUCTION_TOTAL_CHARS,
  type EnvironmentContext,
  type GitContext,
  type InstructionFile,
  type ProjectContext,
} from "@darkcode/shared";

/**
 * Gathers what the model should know before it reads a single file: the
 * machine it is operating on, and the conventions the project states about
 * itself.
 *
 * Without this the model is guessing. It does not know which OS it is on
 * (which decides path separators and whether the `bash` tool will even work),
 * what today's date is, whether the tree has uncommitted work, or that the
 * repository ships an `AGENTS.md` telling contributors how to build and test.
 *
 * Everything here is best-effort. A missing git binary, an unreadable file, or
 * a hung subprocess degrades the context rather than failing the user's turn.
 */

/** Instruction filenames, in the order they are read within a directory. */
const INSTRUCTION_FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Upper bound on any one git subprocess. */
const GIT_TIMEOUT_MS = 2_000;
/** Upper bound on how far up the tree we look for a project root. */
const MAX_PARENT_DEPTH = 32;

/**
 * Run a git subprocess and return trimmed stdout, or null on any failure.
 *
 * Bounded by a timeout because this sits directly in the path of sending a
 * message: git can block indefinitely on a network-mounted repository or one
 * holding a stale `index.lock`, and a hung status call must not hold a user's
 * turn hostage.
 */
async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });

    const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
    try {
      const stdout = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0) return null;
      return stdout.trim();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // git not installed, not a repository, spawn refused — all equivalent here.
    return null;
  }
}

/** Collect branch, HEAD and working-tree dirtiness, when in a repository. */
async function collectGitContext(cwd: string): Promise<GitContext | undefined> {
  const inside = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside !== "true") return undefined;

  const [branch, head, status] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    git(["rev-parse", "--short", "HEAD"], cwd),
    git(["status", "--porcelain"], cwd),
  ]);

  const context: GitContext = {};
  // A fresh repository with no commits reports `HEAD`, which is noise.
  if (branch && branch !== "HEAD") context.branch = branch;
  if (head) context.head = head;
  if (status !== null) {
    context.dirtyCount = status === "" ? 0 : status.split("\n").filter((l) => l.trim() !== "").length;
  }

  return Object.keys(context).length > 0 ? context : undefined;
}

/** Describe the machine and the moment. */
export async function collectEnvironmentContext(cwd = process.cwd()): Promise<EnvironmentContext> {
  const now = new Date();

  const environment: EnvironmentContext = {
    cwd,
    platform: process.platform,
    osVersion: `${osType()} ${release()}`,
    // Local date, not UTC: "what is today" is a question about the user's
    // calendar, and an ISO timestamp in UTC is wrong for anyone west of
    // Greenwich in the evening.
    date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}`,
    bashAvailable: Bun.which("bash") !== null,
  };

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timezone) environment.timezone = timezone;

  const gitContext = await collectGitContext(cwd);
  if (gitContext) environment.git = gitContext;

  return environment;
}

/**
 * Find the project root by walking up for a `.git` directory.
 *
 * Used to bound the instruction-file search. Without a boundary, a CLI started
 * in `~/projects/foo` would climb into the home directory and beyond, picking
 * up unrelated files from wherever the user happens to be.
 */
async function findProjectRoot(cwd: string): Promise<string | null> {
  let dir = cwd;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    // `stat`, not `Bun.file().exists()` — the latter reports false for a
    // directory, and `.git` is a directory in an ordinary checkout. It is a
    // *file* in a worktree or submodule, so accept either.
    const found = await stat(join(dir, ".git")).then(
      () => true,
      () => false,
    );
    if (found) return dir;

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Read one instruction file, applying the per-file cap. */
async function readInstructionFile(
  absolutePath: string,
  displayPath: string,
): Promise<InstructionFile | null> {
  const raw = await readFile(absolutePath, "utf-8").catch(() => null);
  if (raw === null) return null;

  const trimmed = raw.trim();
  if (trimmed === "") return null;

  if (trimmed.length <= MAX_INSTRUCTION_FILE_CHARS) {
    return { path: displayPath, content: trimmed };
  }
  return {
    path: displayPath,
    content: trimmed.slice(0, MAX_INSTRUCTION_FILE_CHARS),
    truncated: true,
  };
}

/**
 * Discover instruction files, outermost first.
 *
 * Order is the contract: the renderer presents them in this sequence, so the
 * nearest file appears last and its conventions read as the most specific. It
 * mirrors how the permission engine layers `defaults < global < project`.
 *
 * The user's own `~/.darkcode/AGENTS.md` comes first of all, so personal
 * preferences apply everywhere but any project can override them.
 */
export async function collectInstructionFiles(cwd = process.cwd()): Promise<InstructionFile[]> {
  const directories: { dir: string; label: (name: string) => string }[] = [];

  const globalDir = join(homedir(), ".darkcode");
  directories.push({ dir: globalDir, label: (name) => `~/.darkcode/${name}` });

  const projectRoot = await findProjectRoot(cwd);

  // Walk from the project root down to the working directory, so outer
  // directories are read before inner ones. With no repository to bound the
  // search, only the working directory itself is considered.
  const chain: string[] = [];
  if (projectRoot) {
    const rel = relative(projectRoot, cwd);
    let dir = projectRoot;
    chain.push(dir);
    if (rel !== "" && !rel.startsWith("..")) {
      for (const segment of rel.split(sep)) {
        if (segment === "") continue;
        dir = join(dir, segment);
        chain.push(dir);
      }
    }
  } else {
    chain.push(cwd);
  }

  for (const dir of chain) {
    directories.push({
      dir,
      label: (name) => {
        const display = projectRoot ? join(relative(projectRoot, dir), name) : name;
        // Normalise to forward slashes so the prompt reads the same on every
        // platform.
        return display.split(sep).join("/");
      },
    });
  }

  const files: InstructionFile[] = [];
  let totalChars = 0;

  for (const { dir, label } of directories) {
    for (const name of INSTRUCTION_FILENAMES) {
      if (files.length >= MAX_INSTRUCTION_FILES) return files;

      const file = await readInstructionFile(join(dir, name), label(name));
      if (!file) continue;

      // Stop before blowing the combined budget rather than truncating
      // mid-sentence across several files: a whole file is more useful to the
      // model than the openings of three.
      if (totalChars + file.content.length > MAX_INSTRUCTION_TOTAL_CHARS) return files;

      totalChars += file.content.length;
      files.push(file);
    }
  }

  return files;
}

/** Gather everything the server needs to build a project-aware system prompt. */
export async function collectProjectContext(cwd = process.cwd()): Promise<ProjectContext> {
  const [environment, instructions] = await Promise.all([
    collectEnvironmentContext(cwd).catch(() => undefined),
    collectInstructionFiles(cwd).catch(() => []),
  ]);

  const context: ProjectContext = {};
  if (environment) context.environment = environment;
  if (instructions && instructions.length > 0) context.instructions = instructions;
  return context;
}
