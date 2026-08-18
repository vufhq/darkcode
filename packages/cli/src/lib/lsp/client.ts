/**
 * LspClient — wraps a single running language-server process.
 *
 * Transport: child-process stdin/stdout via vscode-jsonrpc (Node compat layer).
 * We use node:child_process so Bun supplies proper Node.js Readable/Writable
 * streams, which vscode-languageserver-protocol/node expects.
 *
 * All sendRequest / sendNotification calls use string method names to avoid
 * the branded-type conflicts between the separate vscode-jsonrpc and
 * vscode-languageserver-protocol packages.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type {
  Diagnostic,
  DocumentUri,
  DocumentSymbol,
  Hover,
  InitializeResult,
  Location,
  Position,
  SymbolInformation,
} from "vscode-languageserver-protocol";
import type { ServerEntry } from "./server-registry";

// LSP method strings (avoids the branded-type mismatch between the two pkgs).
const Methods = {
  Initialize: "initialize",
  Shutdown: "shutdown",
  Exit: "exit",
  DidOpen: "textDocument/didOpen",
  DidChange: "textDocument/didChange",
  DidClose: "textDocument/didClose",
  Definition: "textDocument/definition",
  References: "textDocument/references",
  Hover: "textDocument/hover",
  DocumentSymbol: "textDocument/documentSymbol",
  WorkspaceSymbol: "workspace/symbol",
  PublishDiagnostics: "textDocument/publishDiagnostics",
} as const;

export interface LspClientOptions {
  entry: ServerEntry;
  workspaceRoot: string;
}

/** Listeners waiting for diagnostics to arrive for a specific URI. */
type DiagnosticsWaiter = {
  uri: string;
  resolve: (diags: Diagnostic[]) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class LspClient {
  readonly language: string;
  private proc: ChildProcess | null = null;
  private conn: MessageConnection | null = null;
  private initialized = false;
  private diagnostics: Map<string, Diagnostic[]> = new Map();
  private waiters: DiagnosticsWaiter[] = [];
  private openVersions: Map<string, number> = new Map();

  constructor(private readonly opts: LspClientOptions) {
    this.language = opts.entry.language;
  }

  async start(): Promise<void> {
    const { command, args, language } = this.opts.entry;
    const workspaceRoot = this.opts.workspaceRoot;

    // Resolve the server binary against PATH ourselves instead of shelling
    // out to `which`. `which` isn't a Windows builtin, and even when a
    // Git-provided `which.exe` is present it returns an MSYS-style,
    // extensionless path we can't spawn. resolveBinaryPath honours PATHEXT on
    // win32 so a bare `typescript-language-server` resolves to its real
    // `.exe`/`.cmd`, matching how the shell would find it.
    const resolved = resolveBinaryPath(command);
    if (!resolved) {
      throw new Error(
        `LSP: '${command}' not found in PATH — ${language} language server unavailable`,
      );
    }

    this.proc = spawn(resolved, args, {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.proc.stdout || !this.proc.stdin) {
      this.proc.kill();
      throw new Error(`LSP: could not open stdio for ${command}`);
    }

    const reader = new StreamMessageReader(this.proc.stdout);
    const writer = new StreamMessageWriter(this.proc.stdin);
    this.conn = createMessageConnection(reader, writer);

    // Collect diagnostics pushed by the server.
    this.conn.onNotification(Methods.PublishDiagnostics, (params: { uri: string; diagnostics: Diagnostic[] }) => {
      // Normalize the URI so Windows percent-encoded paths match our keys.
      const normalizedUri = normalizeUri(params.uri);
      this.diagnostics.set(normalizedUri, params.diagnostics);
      this.waiters = this.waiters.filter((w) => {
        if (normalizeUri(w.uri) === normalizedUri) {
          clearTimeout(w.timeout);
          w.resolve(params.diagnostics);
          return false;
        }
        return true;
      });
    });

    this.conn.listen();

    const _initResult: InitializeResult = await this.conn.sendRequest(Methods.Initialize, {
      processId: process.pid,
      rootUri: uriFromPath(workspaceRoot),
      capabilities: {
        textDocument: {
          synchronization: {
            didOpen: true,
            didChange: true,
            didClose: true,
          },
          definition: { linkSupport: false },
          references: {},
          hover: {},
          // `hierarchicalDocumentSymbolSupport` asks the server for nested
          // `DocumentSymbol[]` rather than a flat `SymbolInformation[]`. The
          // nesting is what lets a result say "method `run` inside class
          // `Pool`" instead of just "`run`, somewhere".
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
        },
        workspace: {
          workspaceFolders: true,
          symbol: {},
        },
      },
      workspaceFolders: [{ uri: uriFromPath(workspaceRoot), name: "workspace" }],
    });

    this.initialized = true;
  }

  /** Open or refresh a document so the server has its content. */
  openDocument(uri: DocumentUri, text: string, languageId: string): void {
    if (!this.conn || !this.initialized) throw new Error("LspClient not initialized");
    const version = (this.openVersions.get(uri) ?? 0) + 1;
    this.openVersions.set(uri, version);

    if (version === 1) {
      this.conn.sendNotification(Methods.DidOpen, {
        textDocument: { uri, languageId, version, text },
      });
    } else {
      this.conn.sendNotification(Methods.DidChange, {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
  }

  /** Close a document (release server memory). */
  closeDocument(uri: DocumentUri): void {
    if (!this.conn || !this.initialized) return;
    this.openVersions.delete(uri);
    this.conn.sendNotification(Methods.DidClose, {
      textDocument: { uri },
    });
  }

  async definition(uri: DocumentUri, position: Position): Promise<Location | Location[] | null> {
    if (!this.conn || !this.initialized) throw new Error("LspClient not initialized");
    return this.conn.sendRequest(Methods.Definition, {
      textDocument: { uri },
      position,
    }) as Promise<Location | Location[] | null>;
  }

  async references(
    uri: DocumentUri,
    position: Position,
    includeDeclaration = true,
  ): Promise<Location[] | null> {
    if (!this.conn || !this.initialized) throw new Error("LspClient not initialized");
    return this.conn.sendRequest(Methods.References, {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    }) as Promise<Location[] | null>;
  }

  async hover(uri: DocumentUri, position: Position): Promise<Hover | null> {
    if (!this.conn || !this.initialized) throw new Error("LspClient not initialized");
    return this.conn.sendRequest(Methods.Hover, {
      textDocument: { uri },
      position,
    }) as Promise<Hover | null>;
  }

  /**
   * Symbols declared in one document.
   *
   * Servers may answer with either shape the spec allows: nested
   * `DocumentSymbol[]` (what we ask for) or flat `SymbolInformation[]` (what
   * older servers send regardless). Both are returned as-is; normalizing the
   * two is the caller's job.
   */
  async documentSymbols(uri: DocumentUri): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    if (!this.conn || !this.initialized) throw new Error("LspClient not initialized");
    return this.conn.sendRequest(Methods.DocumentSymbol, {
      textDocument: { uri },
    }) as Promise<DocumentSymbol[] | SymbolInformation[] | null>;
  }

  /** Symbols matching a query across the whole workspace. */
  async workspaceSymbols(query: string): Promise<SymbolInformation[] | null> {
    if (!this.conn || !this.initialized) throw new Error("LspClient not initialized");
    return this.conn.sendRequest(Methods.WorkspaceSymbol, { query }) as Promise<
      SymbolInformation[] | null
    >;
  }

  /**
   * Return cached diagnostics for a URI immediately, or wait up to
   * timeoutMs for the server to push them (useful right after an edit).
   */
  getDiagnostics(uri: DocumentUri, timeoutMs = 5_000): Promise<Diagnostic[]> {
    const key = normalizeUri(uri);
    const cached = this.diagnostics.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    return new Promise<Diagnostic[]>((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        resolve([]);
      }, timeoutMs);
      this.waiters.push({ uri: key, resolve, timeout });
    });
  }

  /** Flush cached diagnostics so the next getDiagnostics() waits for fresh ones. */
  invalidateDiagnostics(uri: DocumentUri): void {
    this.diagnostics.delete(normalizeUri(uri));
  }

  async shutdown(): Promise<void> {
    if (!this.conn) return;
    const conn = this.conn;
    this.conn = null;
    this.initialized = false;
    try {
      await conn.sendRequest(Methods.Shutdown, null);
    } catch {
      // ignore — process may already be dead
    }
    try {
      conn.sendNotification(Methods.Exit, null);
    } catch {
      // ignore EPIPE on Windows when the process exits before flush
    }
    try {
      conn.dispose();
    } catch {
      // ignore
    }
    this.proc?.kill();
    this.proc = null;
  }

  /**
   * Synchronous best-effort teardown for process-`exit` cleanup. The async
   * `shutdown()` can't run to completion inside an `exit` handler, so we just
   * dispose the connection and kill the child to avoid orphaned language
   * servers (e.g. a lingering rust-analyzer.exe on Windows).
   */
  killSync(): void {
    try {
      this.conn?.dispose();
    } catch {
      // ignore
    }
    this.conn = null;
    this.initialized = false;
    try {
      this.proc?.kill();
    } catch {
      // ignore
    }
    this.proc = null;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Resolve an executable name against PATH, returning its absolute path or
 * null if it isn't installed. On Windows this honours PATHEXT (so a bare
 * `typescript-language-server` resolves to `…\typescript-language-server.exe`
 * or a `.cmd` shim, preferring a real executable over an extensionless shell
 * script); on POSIX it returns the first PATH hit. Replaces a
 * `spawn("which", …)` probe that silently failed on Windows.
 */
export function resolveBinaryPath(command: string): string | null {
  // An explicit path (absolute or containing a separator) is used as-is.
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? command : null;
  }

  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);

  if (process.platform !== "win32") {
    for (const dir of dirs) {
      const candidate = join(dir, command);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  const hasKnownExt = exts.some((e) => command.toLowerCase().endsWith(e.toLowerCase()));

  for (const dir of dirs) {
    const base = join(dir, command);
    if (hasKnownExt && existsSync(base)) return base;
    for (const ext of exts) {
      const candidate = base + ext;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Inverse of `uriFromPath`: turn a `file://` URI back into a filesystem path.
 *
 * Servers percent-encode URIs, so spaces arrive as `%20` and a path built by
 * naive string-slicing would not exist on disk. Anything that isn't a
 * `file://` URI is returned unchanged — better to surface an odd path than to
 * throw while formatting a result.
 */
export function pathFromUri(uri: string): string {
  if (!uri.startsWith("file://")) return uri;

  let path = uri.slice("file://".length);
  try {
    path = decodeURIComponent(path);
  } catch {
    // Malformed escape — keep the raw form rather than failing the call.
  }

  // `file:///C:/x` → `C:/x`, while POSIX `file:///home/x` keeps its leading
  // slash.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}

export function uriFromPath(fsPath: string): DocumentUri {
  // Normalise Windows backslashes and ensure file:/// prefix.
  const forward = fsPath.replace(/\\/g, "/");
  if (forward.startsWith("/")) {
    return `file://${forward}`;
  }
  // Windows drive letter: C:/... → file:///C:/...
  return `file:///${forward}`;
}

/**
 * Normalize a file URI for consistent map keys.
 * Decodes percent-encoding and lowercases the entire URI so that
 * `file:///C%3A/foo` and `file:///c:/foo` both map to the same key.
 */
export function normalizeUri(uri: string): string {
  try {
    return decodeURIComponent(uri).toLowerCase();
  } catch {
    return uri.toLowerCase();
  }
}

export function extToLanguageId(ext: string): string {
  const bare = ext.startsWith(".") ? ext.slice(1) : ext;
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescriptreact",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascriptreact",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    pyi: "python",
    rs: "rust",
    go: "go",
  };
  return map[bare] ?? bare;
}
