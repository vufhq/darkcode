import { mkdir, readFile, readdir, realpath, stat, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { toolInputSchemas, Mode, type ModeType } from "@darkcode/shared";
import { checkPermission, isReadAllowed } from "./permissions/engine";
import { getLspPool } from "./lsp/pool";
import { pathFromUri } from "./lsp/client";
import { flattenDocumentSymbols, flattenWorkspaceSymbols } from "./lsp/symbols";
import { scrubbedBashEnv } from "./scrubbed-env";
import { applyEdit } from "./apply-edit";
import { splitBom, splitLines } from "./text";
import { GitignoreMatcher } from "./gitignore";

// Per-call read ceiling. Generous on purpose: the model needs to see whole
// source files to reason about them, and `readFile` now takes offset/limit so
// anything larger is reachable by paging rather than being silently lost.
// Real cost is bounded downstream by the server's 2MB body limit and the
// context-window projection in chat.ts.
const MAX_READ_LINES = 2_000;
const MAX_READ_CHARS = 400_000;
// Longest single line we'll echo back before truncating it. Stops a minified
// bundle from blowing the whole budget on one line.
const MAX_LINE_CHARS = 2_000;
const MAX_RESULTS = 200;
const MAX_MATCHES = 50;
const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT = 30_000;
// Upper bounds for the pure-JS grep walker (below). Caps the number of files
// scanned and the size of any single file read, so a huge tree or a stray
// multi-megabyte blob can't stall a search.
const MAX_GREP_FILES = 2_000;
const MAX_GREP_FILE_BYTES = 2_000_000;

function assertInside(cwd: string, resolved: string) {
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path is outside the project directory");
  }
  return rel;
}

// Lexical containment check. `resolve`/`relative` are string operations, so
// this alone is satisfied by a symlink that points anywhere on disk — see
// `resolveInsideCwd` below, which is what callers should use.
function resolveInsideCwdLexical(path: string) {
  const cwd = process.cwd();
  const resolved = resolve(cwd, path);
  assertInside(cwd, resolved);
  return { cwd, resolved };
}

// Containment check that survives symlinks.
//
// The lexical check above passes for `notes/id_rsa` even when `notes` is a
// symlink to `~/.ssh` — which matters here more than in most programs, because
// cloning and working inside an untrusted repository is this tool's normal
// workflow, and a repo can ship a symlink. So we resolve the real path before
// judging containment, walking up to the nearest existing ancestor for paths
// that don't exist yet (a file we're about to create).
//
// The project root is realpath'd too: if the user's cwd is itself reached
// through a symlink, comparing a resolved path against an unresolved root
// would reject every legitimate access.
async function resolveInsideCwd(path: string) {
  const cwd = process.cwd();
  const lexical = resolve(cwd, path);
  // Fail fast on the obvious cases so a clearly-outside path never touches the
  // filesystem at all.
  assertInside(cwd, lexical);

  const realCwd = await realpath(cwd).catch(() => cwd);

  // Find the nearest ancestor that exists and resolve *that*, then re-append
  // the not-yet-existing tail.
  let existing = lexical;
  const tail: string[] = [];
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) {
        // Walked to the filesystem root without finding anything real.
        existing = realCwd;
        break;
      }
      tail.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }
  }

  const resolved = tail.length > 0 ? join(existing, ...tail) : existing;
  assertInside(realCwd, resolved);

  // Callers report paths relative to the project as the user sees it, so keep
  // returning the lexical cwd for display purposes.
  return { cwd, resolved };
}

// Read-side policy gate. Cheap and synchronous-ish, but it has to happen for
// every tool that returns file *contents* to the model.
async function guardRead(cwd: string, resolved: string) {
  await checkPermission({ kind: "fs-read", projectRelativePath: relative(cwd, resolved) });
}

function truncate(value: string, limit: number) {
  return value.length > limit
    ? `${value.slice(0, limit)}\n... (truncated, ${value.length} total chars)`
    : value;
}

const MAX_DIAGNOSTICS = 10;
// Default cap on symbols returned per lspSymbols call. A workspace search for
// a common substring can otherwise return thousands.
const DEFAULT_SYMBOL_LIMIT = 100;

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
  "lspSymbols",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk a directory tree yielding project-relative file paths, honouring
 * `.gitignore` as it descends.
 *
 * Written as a recursive walk rather than `Bun.Glob.scan` specifically so that
 * ignored directories can be *pruned*. A glob scan enumerates the whole tree
 * and leaves the caller to filter afterwards, which still pays the cost of
 * walking `node_modules` and `dist`. Pruning is sound here because git cannot
 * re-include a path whose parent directory is excluded, so nothing reachable
 * only through an ignored directory can ever be wanted.
 *
 * Each directory's own `.gitignore` is loaded on the way in, so nested files
 * take effect for their subtree and take precedence over shallower ones.
 */
async function* walkProjectFiles(
  root: string,
  matcher: GitignoreMatcher,
  relDir = "",
): AsyncGenerator<string> {
  const dirAbs = relDir ? join(root, relDir) : root;

  const gitignore = await readFile(join(dirAbs, ".gitignore"), "utf-8").catch(() => null);
  if (gitignore !== null) matcher.add(relDir, gitignore);

  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip rather than abort the whole search
  }

  // Deterministic order, so repeated searches return matches in the same
  // sequence and truncation cuts at the same place.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    // Hidden entries were already excluded before .gitignore support (the old
    // scan ran with `dot: false`); keeping that also covers `.git` itself.
    if (entry.name.startsWith(".")) continue;

    // Symlinks are neither followed nor returned. Following them risks cycles,
    // and a link can point outside the project entirely.
    if (entry.isSymbolicLink()) continue;

    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      // Belt and braces: a project with no .gitignore at all should still not
      // have its dependency tree searched.
      if (entry.name === "node_modules") continue;
      if (matcher.isIgnored(rel, true)) continue;
      yield* walkProjectFiles(root, matcher, rel);
      continue;
    }

    if (!entry.isFile()) continue;
    if (matcher.isIgnored(rel, false)) continue;
    yield rel;
  }
}

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
      const { path, offset, limit } = toolInputSchemas.readFile.parse(input);
      const { cwd, resolved } = await resolveInsideCwd(path);
      await guardRead(cwd, resolved);

      const raw = await readFile(resolved, "utf-8");
      // Show the model the file's *text*, not its encoding artifacts. Splitting
      // on "\n" alone leaves a trailing `\r` on every line of a CRLF file, and
      // a BOM shows up as an invisible character at the head of line 1 — both
      // become stray characters in the model's context that it may then copy
      // back into an `oldString` or a `writeFile` payload.
      const allLines = splitLines(splitBom(raw).body);
      // A file ending in a newline splits to a trailing empty element; counting
      // it would report a 10-line file as 11 and make `nextOffset` point past
      // the end.
      if (allLines.length > 1 && allLines[allLines.length - 1] === "") allLines.pop();
      const totalLines = allLines.length;

      // `offset` is 1-based to match how the model sees line numbers everywhere
      // else (grep output, LSP ranges, editor references).
      const start = Math.max(0, (offset ?? 1) - 1);
      const lineLimit = Math.min(limit ?? MAX_READ_LINES, MAX_READ_LINES);

      const selected: string[] = [];
      let chars = 0;
      let charBudgetHit = false;
      for (const line of allLines.slice(start, start + lineLimit)) {
        const clipped = line.length > MAX_LINE_CHARS
          ? `${line.slice(0, MAX_LINE_CHARS)}… (line truncated, ${line.length} chars)`
          : line;
        if (chars + clipped.length > MAX_READ_CHARS) {
          charBudgetHit = true;
          break;
        }
        chars += clipped.length + 1;
        selected.push(clipped);
      }

      const nextOffset = start + selected.length + 1;
      const hasMore = nextOffset <= totalLines;

      return {
        content: selected.join("\n"),
        startLine: start + 1,
        endLine: start + selected.length,
        totalLines,
        ...(hasMore
          ? {
              truncated: true,
              nextOffset,
              // Say plainly how to get the rest — a bare `truncated: true` left
              // the model with no route to the remainder of the file.
              hint: charBudgetHit
                ? `Output size limit reached. Continue with offset: ${nextOffset}.`
                : `Showing ${selected.length} of ${totalLines} lines. Continue with offset: ${nextOffset}.`,
            }
          : {}),
      };
    }
    case "listDirectory": {
      const { path } = toolInputSchemas.listDirectory.parse(input);
      const { cwd, resolved } = await resolveInsideCwd(path);
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
      const { cwd, resolved } = await resolveInsideCwd(path);
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
      const { pattern, path, include, ignoreCase } = toolInputSchemas.grep.parse(input);
      const { cwd, resolved } = await resolveInsideCwd(path);

      // Pure-JS walker rather than shelling out to the Unix `grep` binary,
      // which doesn't exist on a stock Windows install. `walkProjectFiles`
      // enumerates candidate files; we read and scan each line ourselves.
      let regex: RegExp;
      try {
        // Only `i` is exposed, rather than letting the model pass arbitrary
        // flags. `g` in particular would be a correctness bug here: it makes
        // `RegExp.test` stateful via `lastIndex`, so a reused regex would skip
        // every other matching line.
        regex = new RegExp(pattern, ignoreCase ? "i" : "");
      } catch (error) {
        throw new Error(`Invalid grep pattern: ${(error as Error).message}`);
      }

      // `include` historically matched at any depth (`**/<include>`). Test the
      // bare pattern too so an anchored pattern like `src/*.ts` still works.
      const includeGlobs = include
        ? [new Bun.Glob(`**/${include}`), new Bun.Glob(include)]
        : null;

      const matcher = new GitignoreMatcher();
      const matches: { file: string; line: number; content: string }[] = [];
      let truncated = false;
      let filesScanned = 0;
      let skippedProtected = 0;

      scan: for await (const rel of walkProjectFiles(resolved, matcher)) {
        if (includeGlobs && !includeGlobs.some((g) => g.match(rel))) continue;

        // The budget counts files actually searched. Charging it for files
        // that were filtered out would let a large `dist/` exhaust the limit
        // before the search reached any source at all.
        if (filesScanned >= MAX_GREP_FILES) {
          truncated = true;
          break;
        }
        filesScanned++;

        const abs = resolve(resolved, rel);
        // grep returns matching *lines*, so it's a content read like any other
        // — a search for `API_KEY` would otherwise exfiltrate every secret in
        // the tree in one call. Skip protected files rather than aborting the
        // whole search; the refusal is still audited.
        if (!isReadAllowed(relative(cwd, abs))) {
          skippedProtected++;
          continue;
        }
        const file = Bun.file(abs);
        if (file.size > MAX_GREP_FILE_BYTES) continue;

        let content: string;
        try {
          content = await file.text();
        } catch {
          continue; // unreadable / binary — skip
        }

        // Split on either convention. With a bare `content.split("\n")` every
        // line of a CRLF file keeps a trailing `\r`, which silently breaks any
        // `$`-anchored pattern the model writes and ships an invisible control
        // character back in the match text.
        const lines = splitLines(content);
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

      const protectedNote =
        skippedProtected > 0
          ? { skippedProtectedFiles: skippedProtected }
          : {};
      if (matches.length === 0) {
        return { matches: [], message: "No matches found", ...protectedNote };
      }
      return { matches, ...(truncated ? { truncated: true } : {}), ...protectedNote };
    }
    case "writeFile": {
      const { path, content } = toolInputSchemas.writeFile.parse(input);
      const { cwd, resolved } = await resolveInsideCwd(path);
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
      const { cwd, resolved } = await resolveInsideCwd(path);
      await checkPermission({ kind: "fs", projectRelativePath: relative(cwd, resolved) });
      const content = await readFile(resolved, "utf-8");
      // All the matching and splicing logic lives in `applyEdit`, which is pure
      // and unit-tested. This branch only does I/O.
      const edited = applyEdit(content, oldString, newString);

      await writeFile(resolved, edited.content, "utf-8");
      const editResult: Record<string, unknown> = {
        success: true as const,
        path: relative(cwd, resolved),
      };
      // Say so when a fallback strategy rescued the edit. Silence here would
      // teach the model that its near-miss quoting was fine, and it would keep
      // doing it; worse, a fuzzy match is the one case where the region
      // replaced might not be the region intended, so the user's agent should
      // be able to see it happened.
      if (edited.strategy !== "exact") {
        editResult["matchedBy"] = edited.strategy;
        editResult["note"] =
          `oldString did not match exactly; matched via the '${edited.strategy}' strategy. ` +
          "Quote the file verbatim to avoid relying on fuzzy matching.";
      }
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
        cwd: resolveInsideCwdLexical(".").resolved,
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
      const { resolved } = await resolveInsideCwd(path);
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
      const { resolved } = await resolveInsideCwd(path);
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
      const { resolved } = await resolveInsideCwd(path);
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
      const { resolved } = await resolveInsideCwd(path);
      const pool = getLspPool();
      const diags = await pool.getDiagnostics(resolved);
      return formatDiagnostics(diags);
    }
    case "lspSymbols": {
      const { query, path, limit } = toolInputSchemas.lspSymbols.parse(input);
      if ((query === undefined) === (path === undefined)) {
        throw new Error("Provide exactly one of `query` (project-wide search) or `path` (one file)");
      }

      const cwd = process.cwd();
      const max = limit ?? DEFAULT_SYMBOL_LIMIT;
      const pool = getLspPool();
      // LSP hands back `file://` URIs; the model works in project-relative
      // paths everywhere else, so translate before returning.
      const toDisplayPath = (uri: string) => relative(cwd, pathFromUri(uri)) || ".";

      if (path !== undefined) {
        const { resolved } = await resolveInsideCwd(path);
        await guardRead(cwd, resolved);

        const raw = await pool.documentSymbols(resolved);
        if (raw === null) {
          return {
            symbols: [],
            message: "No language server is available for this file type.",
          };
        }
        const symbols = flattenDocumentSymbols(raw, { limit: max, toDisplayPath }).map((s) => ({
          ...s,
          file: s.file ?? relative(cwd, resolved),
        }));
        return {
          symbols,
          ...(symbols.length === 0 ? { message: "No symbols found in this file." } : {}),
          ...(symbols.length >= max ? { truncated: true } : {}),
        };
      }

      const result = await pool.workspaceSymbols(query!);
      if (result === null) {
        return {
          symbols: [],
          message:
            "No language server is running for this project, so a project-wide symbol search is not available. Use grep instead, or call lspSymbols with a `path`.",
        };
      }

      // A workspace search can reach files the read policy protects; drop
      // those rather than leaking their symbol names.
      const symbols = flattenWorkspaceSymbols(result.symbols, { toDisplayPath }).filter(
        (s) => s.file === undefined || isReadAllowed(s.file),
      );
      const limited = symbols.slice(0, max);

      // Never let "still indexing" be reported as "does not exist" — that is
      // the one wrong answer the model would act on with full confidence.
      const emptyMessage = result.indexWarm
        ? `No symbols matching "${query}".`
        : `No symbols matching "${query}" yet — the language server is still indexing this project. Retry shortly, or use grep in the meantime.`;

      return {
        symbols: limited,
        ...(limited.length === 0 ? { message: emptyMessage } : {}),
        ...(symbols.length > max ? { truncated: true } : {}),
      };
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
};
