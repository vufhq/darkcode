import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { toolInputSchemas, Mode, type ModeType } from "@darkcode/shared";
import { checkPermission } from "./permissions/engine";
import { getLspPool } from "./lsp/pool";
import { scrubbedBashEnv } from "./scrubbed-env";

const MAX_FILE_SIZE = 10_000;
const MAX_RESULTS = 200;
const MAX_MATCHES = 50;
const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT = 30_000;
// Upper bounds for the pure-JS grep walker (below). Caps the number of files
// scanned and the size of any single file read, so a huge tree or a stray
// multi-megabyte blob can't stall a search.
const MAX_GREP_FILES = 2_000;
const MAX_GREP_FILE_BYTES = 2_000_000;

function resolveInsideCwd(path: string) {
  const cwd = process.cwd();
  const resolved = resolve(cwd, path);
  const rel = relative(cwd, resolved);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path is outside the project directory");
  }

  return { cwd, resolved };
}

function truncate(value: string, limit: number) {
  return value.length > limit
    ? `${value.slice(0, limit)}\n... (truncated, ${value.length} total chars)`
    : value;
}

const MAX_DIAGNOSTICS = 10;

/** Tools allowed in PLAN mode (read-only, plus LSP which is always read-only). */
const PLAN_MODE_TOOLS = new Set([
  "readFile",
  "listDirectory",
  "glob",
  "grep",
  "lspDefinition",
  "lspReferences",
  "lspHover",
  "lspDiagnostics",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEVERITY_LABEL: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

function formatDiagnostics(diags: import("vscode-languageserver-protocol").Diagnostic[]) {
  const top = diags.slice(0, MAX_DIAGNOSTICS);
  const truncated = diags.length > MAX_DIAGNOSTICS;
  return {
    count: diags.length,
    diagnostics: top.map((d) => ({
      severity: SEVERITY_LABEL[d.severity ?? 1] ?? "error",
      message: d.message,
      range: d.range,
      code: d.code,
      source: d.source,
    })),
    ...(truncated ? { truncated: true, showing: MAX_DIAGNOSTICS } : {}),
  };
}

/**
 * After a BUILD-mode write, ask the LSP pool for fresh diagnostics.
 * Returns null if the language server is unavailable for this file type.
 */
async function postEditDiagnostics(absolutePath: string) {
  try {
    const pool = getLspPool();
    // refreshAndGetDiagnostics invalidates cache, re-reads the file, and waits.
    const diags = await pool.refreshAndGetDiagnostics(absolutePath);
    return formatDiagnostics(diags);
  } catch {
    return null;
  }
}

export async function executeLocalTool(toolName: string, input: unknown, mode: ModeType) {
  if (mode === Mode.PLAN && !PLAN_MODE_TOOLS.has(toolName)) {
    throw new Error(`Tool ${toolName} is not available in PLAN mode`);
  }

  switch (toolName) {
    case "readFile": {
      const { path } = toolInputSchemas.readFile.parse(input);
      const { resolved } = resolveInsideCwd(path);
      const content = await readFile(resolved, "utf-8");
      return content.length > MAX_FILE_SIZE
        ? { content: content.slice(0, MAX_FILE_SIZE), truncated: true, totalLength: content.length }
        : { content };
    }
    case "listDirectory": {
      const { path } = toolInputSchemas.listDirectory.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      const entries = await readdir(resolved);
      const results: { name: string; type: "file" | "directory" }[] = [];

      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        const info = await stat(join(resolved, entry));
        results.push({ name: entry, type: info.isDirectory() ? "directory" : "file" });
      }

      results.sort((a, b) =>
        a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name),
      );
      return { path: relative(cwd, resolved) || ".", entries: results };
    }
    case "glob": {
      const { pattern, path } = toolInputSchemas.glob.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      const glob = new Bun.Glob(pattern);
      const files: string[] = [];
      let truncated = false;

      for await (const match of glob.scan({ cwd: resolved, dot: false, onlyFiles: true })) {
        if (match.includes("node_modules")) continue;
        if (files.length >= MAX_RESULTS) {
          truncated = true;
          break;
        }
        files.push(relative(cwd, resolve(resolved, match)));
      }

      files.sort();
      return { files, ...(truncated ? { truncated: true } : {}) };
    }
    case "grep": {
      const { pattern, path, include } = toolInputSchemas.grep.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);

      // Pure-JS walker rather than shelling out to the Unix `grep` binary,
      // which doesn't exist on a stock Windows install. Bun.Glob enumerates
      // candidate files; we read and scan each line ourselves.
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (error) {
        throw new Error(`Invalid grep pattern: ${(error as Error).message}`);
      }

      const scanPattern = include ? `**/${include}` : "**/*";
      const glob = new Bun.Glob(scanPattern);
      const matches: { file: string; line: number; content: string }[] = [];
      let truncated = false;
      let filesScanned = 0;

      scan: for await (const rel of glob.scan({ cwd: resolved, dot: false, onlyFiles: true })) {
        if (rel.includes("node_modules") || rel.includes(".git")) continue;
        if (filesScanned >= MAX_GREP_FILES) {
          truncated = true;
          break;
        }
        filesScanned++;

        const abs = resolve(resolved, rel);
        const file = Bun.file(abs);
        if (file.size > MAX_GREP_FILE_BYTES) continue;

        let content: string;
        try {
          content = await file.text();
        } catch {
          continue; // unreadable / binary — skip
        }

        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i]!)) continue;
          if (matches.length >= MAX_MATCHES) {
            truncated = true;
            break scan;
          }
          matches.push({
            file: relative(cwd, abs),
            line: i + 1,
            content: truncate(lines[i]!, 1000),
          });
        }
      }

      if (matches.length === 0) return { matches: [], message: "No matches found" };
      return { matches, ...(truncated ? { truncated: true } : {}) };
    }
    case "writeFile": {
      const { path, content } = toolInputSchemas.writeFile.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      await checkPermission({ kind: "fs", projectRelativePath: relative(cwd, resolved) });
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf-8");
      const writeResult: Record<string, unknown> = {
        success: true as const,
        path: relative(cwd, resolved),
        bytesWritten: Buffer.byteLength(content, "utf-8"),
      };
      // Post-edit diagnostics feedback loop (BUILD mode only).
      if (mode === Mode.BUILD) {
        const diags = await postEditDiagnostics(resolved);
        if (diags !== null) writeResult["diagnostics"] = diags;
      }
      return writeResult;
    }
    case "editFile": {
      const { path, oldString, newString } = toolInputSchemas.editFile.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      await checkPermission({ kind: "fs", projectRelativePath: relative(cwd, resolved) });
      const content = await readFile(resolved, "utf-8");
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) throw new Error("oldString not found in file");
      if (occurrences > 1) throw new Error(`oldString is ambiguous; found ${occurrences} matches`);

      await writeFile(resolved, content.replace(oldString, newString), "utf-8");
      const editResult: Record<string, unknown> = {
        success: true as const,
        path: relative(cwd, resolved),
      };
      // Post-edit diagnostics feedback loop (BUILD mode only).
      if (mode === Mode.BUILD) {
        const diags = await postEditDiagnostics(resolved);
        if (diags !== null) editResult["diagnostics"] = diags;
      }
      return editResult;
    }
    case "bash": {
      const { command, timeout = DEFAULT_TIMEOUT } = toolInputSchemas.bash.parse(input);
      await checkPermission({ kind: "bash", command });
      // `bash` isn't on the PATH of a stock Windows box. Resolve it explicitly
      // (Bun.which is PATHEXT-aware) and fail with an actionable message rather
      // than letting Bun.spawn throw a bare ENOENT.
      const bashPath = Bun.which("bash");
      if (!bashPath) {
        throw new Error(
          "The bash tool requires `bash` on your PATH. On Windows, install Git for Windows (which bundles bash) or use WSL.",
        );
      }
      const proc = Bun.spawn([bashPath, "-c", command], {
        cwd: resolveInsideCwd(".").resolved,
        stdout: "pipe",
        stderr: "pipe",
        env: scrubbedBashEnv(),
      });
      const timer = setTimeout(() => proc.kill(), timeout);
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      return {
        stdout: truncate(stdout, MAX_OUTPUT),
        stderr: truncate(stderr, MAX_OUTPUT),
        exitCode,
      };
    }
    case "lspDefinition": {
      const { path, line, character } = toolInputSchemas.lspDefinition.parse(input);
      const { resolved } = resolveInsideCwd(path);
      const pool = getLspPool();
      const result = await pool.definition(resolved, { line, character });
      if (!result) return { locations: [], message: "No definition found or language server unavailable" };
      const locations = Array.isArray(result) ? result : [result];
      return {
        locations: locations.slice(0, MAX_RESULTS).map((loc) => ({
          uri: loc.uri,
          range: loc.range,
        })),
      };
    }
    case "lspReferences": {
      const { path, line, character, includeDeclaration } =
        toolInputSchemas.lspReferences.parse(input);
      const { resolved } = resolveInsideCwd(path);
      const pool = getLspPool();
      const result = await pool.references(resolved, { line, character }, includeDeclaration);
      if (!result) return { locations: [], message: "No references found or language server unavailable" };
      const truncated = result.length > MAX_RESULTS;
      return {
        locations: result.slice(0, MAX_RESULTS).map((loc) => ({
          uri: loc.uri,
          range: loc.range,
        })),
        ...(truncated ? { truncated: true, total: result.length } : {}),
      };
    }
    case "lspHover": {
      const { path, line, character } = toolInputSchemas.lspHover.parse(input);
      const { resolved } = resolveInsideCwd(path);
      const pool = getLspPool();
      const result = await pool.hover(resolved, { line, character });
      if (!result) return { content: null, message: "No hover information or language server unavailable" };
      const content =
        typeof result.contents === "string"
          ? result.contents
          : Array.isArray(result.contents)
            ? result.contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n")
            : "value" in result.contents
              ? result.contents.value
              : String(result.contents);
      return { content: truncate(content, MAX_OUTPUT), range: result.range };
    }
    case "lspDiagnostics": {
      const { path } = toolInputSchemas.lspDiagnostics.parse(input);
      const { resolved } = resolveInsideCwd(path);
      const pool = getLspPool();
      const diags = await pool.getDiagnostics(resolved);
      return formatDiagnostics(diags);
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
};
