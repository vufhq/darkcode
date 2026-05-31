/**
 * LspPool — keeps one LspClient per language, lazily started and reused
 * across turns. Handles crash recovery and clean shutdown on process exit.
 */

import { extname } from "path";
import { readFile } from "fs/promises";
import type { Diagnostic, Location, Hover, Position } from "vscode-languageserver-protocol";
import { LspClient, uriFromPath, extToLanguageId } from "./client";
import { findServerForExtension } from "./server-registry";

const DIAGNOSTICS_TIMEOUT_MS = 10_000;

// Process-wide guard that swallows benign EPIPE errors from vscode-jsonrpc
// when an LSP server exits before we finish flushing a notification. Installed
// exactly once, no matter how many pools are constructed, so handlers can't
// stack up. Anything that isn't a benign EPIPE is re-thrown — Node prints its
// original stack and terminates the process (it guards against recursion when
// a handler throws), preserving normal crash behavior for real bugs.
let epipeGuardInstalled = false;

function installEpipeGuardOnce(): void {
  if (epipeGuardInstalled) return;
  epipeGuardInstalled = true;
  process.on("uncaughtException", (err) => {
    if (
      err instanceof Error &&
      (("code" in err && (err as NodeJS.ErrnoException).code === "EPIPE") ||
        err.message.includes("EPIPE"))
    ) {
      return; // benign — LSP server exited before we finished flushing
    }
    throw err; // re-throw anything else
  });
}

export class LspPool {
  /** language → active client */
  private clients: Map<string, LspClient> = new Map();
  private workspaceRoot: string;
  private shuttingDown = false;
  /** Languages for which we already logged a "not found" warning. */
  private warnedMissing: Set<string> = new Set();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;

    // Best-effort cleanup of child language servers when the process exits.
    // killSync is synchronous because an `exit` handler can't await.
    //
    // We deliberately do NOT register SIGINT/SIGTERM handlers here. The TUI
    // owns Ctrl+C — the OpenTUI renderer runs with `exitOnCtrlC: false` and
    // routes the key through its own dialogs. The pool is created lazily (on
    // the first LSP call or BUILD-mode write), so a force-exit SIGINT handler
    // installed here would silently start overriding that the moment the LSP
    // layer warms up.
    process.on("exit", () => {
      for (const client of this.clients.values()) {
        client.killSync();
      }
    });

    // Suppress EPIPE from vscode-jsonrpc when a server exits mid-flush.
    // Installed once process-wide (see installEpipeGuardOnce).
    installEpipeGuardOnce();
  }

  /**
   * Obtain (or start) a client for the language associated with `ext`.
   * Returns null if no server is configured or the binary is missing.
   */
  async clientForExt(ext: string): Promise<LspClient | null> {
    if (this.shuttingDown) return null;
    const entry = findServerForExtension(ext);
    if (!entry) return null;

    const existing = this.clients.get(entry.language);
    if (existing) return existing;

    const client = new LspClient({ entry, workspaceRoot: this.workspaceRoot });
    try {
      await client.start();
      this.clients.set(entry.language, client);
      return client;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.warnedMissing.has(entry.language)) {
        this.warnedMissing.add(entry.language);
        // Log once; never crash the CLI.
        console.error(`[LSP] ${msg}`);
      }
      return null;
    }
  }

  /**
   * Open (or refresh) a file in the relevant language server and return
   * the client. The caller receives the file content too so it can reuse it.
   */
  async prepareDocument(
    absolutePath: string,
  ): Promise<{ client: LspClient; uri: string; text: string } | null> {
    const ext = extname(absolutePath);
    const client = await this.clientForExt(ext);
    if (!client) return null;

    let text: string;
    try {
      text = await readFile(absolutePath, "utf-8");
    } catch {
      return null;
    }

    const uri = uriFromPath(absolutePath);
    const languageId = extToLanguageId(ext);
    await client.openDocument(uri, text, languageId);
    return { client, uri, text };
  }

  // -------------------------------------------------------------------------
  // High-level tool implementations
  // -------------------------------------------------------------------------

  async definition(
    absolutePath: string,
    position: Position,
  ): Promise<Location | Location[] | null> {
    const prepared = await this.prepareDocument(absolutePath);
    if (!prepared) return null;
    return prepared.client.definition(prepared.uri, position);
  }

  async references(
    absolutePath: string,
    position: Position,
    includeDeclaration = true,
  ): Promise<Location[] | null> {
    const prepared = await this.prepareDocument(absolutePath);
    if (!prepared) return null;
    return prepared.client.references(prepared.uri, position, includeDeclaration);
  }

  async hover(absolutePath: string, position: Position): Promise<Hover | null> {
    const prepared = await this.prepareDocument(absolutePath);
    if (!prepared) return null;
    return prepared.client.hover(prepared.uri, position);
  }

  async getDiagnostics(absolutePath: string): Promise<Diagnostic[]> {
    const prepared = await this.prepareDocument(absolutePath);
    if (!prepared) return [];
    return prepared.client.getDiagnostics(prepared.uri, DIAGNOSTICS_TIMEOUT_MS);
  }

  /**
   * Refresh a document after an edit and return fresh diagnostics.
   * Invalidates any cached diagnostics so we wait for the server to push new ones.
   */
  async refreshAndGetDiagnostics(absolutePath: string): Promise<Diagnostic[]> {
    const ext = extname(absolutePath);
    const client = await this.clientForExt(ext);
    if (!client) return [];

    const uri = uriFromPath(absolutePath);
    client.invalidateDiagnostics(uri);

    // Re-open with the new content so the server re-checks.
    const prepared = await this.prepareDocument(absolutePath);
    if (!prepared) return [];
    return prepared.client.getDiagnostics(uri, DIAGNOSTICS_TIMEOUT_MS);
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([...this.clients.values()].map((c) => c.shutdown().catch(() => {})));
    this.clients.clear();
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton — one pool per CLI process.
// ---------------------------------------------------------------------------

let _pool: LspPool | null = null;

export function getLspPool(): LspPool {
  if (!_pool) {
    _pool = new LspPool(process.cwd());
  }
  return _pool;
}
