import { z } from "zod";

/**
 * Ambient context about the user's machine and project, gathered CLI-side and
 * sent with each chat request.
 *
 * It has to travel over the wire because of how DarkCode is split: the system
 * prompt is built on the server, but the working directory, the git checkout,
 * and the project's instruction files only exist on the user's machine. The
 * server is stateless and never sees the filesystem, so anything it should
 * know about the project has to be collected by the CLI and sent — the same
 * arrangement `mcpTools` already uses.
 *
 * Every field is optional. Collection is best-effort: a machine without git,
 * a directory with no instruction files, or a git command that times out all
 * degrade to a smaller context rather than failing the turn.
 */

/**
 * Hard ceiling on a single instruction file, in characters (~6k tokens).
 *
 * Sized to fit a substantial real CLAUDE.md whole. Truncating a conventions
 * file is worse than it sounds: the model silently receives the first half of
 * the rules and never learns the rest, so it follows the build instructions
 * and misses the "things to avoid" section underneath them.
 */
export const MAX_INSTRUCTION_FILE_CHARS = 24_000;
/** Hard ceiling on how many instruction files one request may carry. */
export const MAX_INSTRUCTION_FILES = 6;
/**
 * Ceiling on the combined size of all instruction files (~8k tokens).
 *
 * This is a running cost, not a one-off: the system prompt is re-sent on every
 * turn, so it is charged against the context window and against metered
 * credits each time. Raise it only with that in mind.
 */
export const MAX_INSTRUCTION_TOTAL_CHARS = 32_000;

/**
 * One discovered instruction file (`AGENTS.md` or `CLAUDE.md`).
 *
 * The content is repository data, not a trusted instruction channel — a cloned
 * project can ship whatever it likes in its `AGENTS.md`. The server renders it
 * inside a clearly delimited block that states it cannot override safety rules
 * or the permission engine; the caps here bound the damage a hostile or merely
 * enormous file can do to the context window.
 */
export const instructionFileSchema = z.object({
  /** Display path, relative to the project root where possible. */
  path: z.string().min(1).max(512),
  content: z.string().max(MAX_INSTRUCTION_FILE_CHARS),
  /** True when the file was truncated to fit the per-file cap. */
  truncated: z.boolean().optional(),
});

export type InstructionFile = z.infer<typeof instructionFileSchema>;

/** Summary of the git checkout, when the project is a repository. */
export const gitContextSchema = z.object({
  branch: z.string().max(256).optional(),
  /** Number of paths with uncommitted changes, staged or not. */
  dirtyCount: z.number().int().min(0).max(1_000_000).optional(),
  /** Short hash of HEAD. */
  head: z.string().max(64).optional(),
});

export type GitContext = z.infer<typeof gitContextSchema>;

export const environmentContextSchema = z.object({
  /** Absolute path the tools resolve against. */
  cwd: z.string().min(1).max(1_024),
  /** `process.platform` — `win32`, `darwin`, `linux`. */
  platform: z.string().max(32),
  /** OS version string, when available. */
  osVersion: z.string().max(128).optional(),
  /** Today's date, ISO `YYYY-MM-DD`, in the user's local timezone. */
  date: z.string().max(32).optional(),
  /** IANA timezone name, e.g. `Europe/London`. */
  timezone: z.string().max(64).optional(),
  /**
   * Whether a `bash` binary is on PATH. Load-bearing on Windows, where the
   * `bash` tool fails outright without Git-for-Windows or WSL installed — the
   * model should know that before it writes a shell command.
   */
  bashAvailable: z.boolean().optional(),
  git: gitContextSchema.optional(),
});

export type EnvironmentContext = z.infer<typeof environmentContextSchema>;

export const projectContextSchema = z.object({
  environment: environmentContextSchema.optional(),
  instructions: z.array(instructionFileSchema).max(MAX_INSTRUCTION_FILES).optional(),
});

export type ProjectContext = z.infer<typeof projectContextSchema>;
