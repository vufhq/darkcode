/**
 * LspPool — keeps one LspClient per language, lazily started and reused
 * across turns. Handles crash recovery and clean shutdown on process exit.
 */

import { extname } from "path";
import { readFile } from "fs/promises";
import type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  Position,
  SymbolInformation,
} from "vscode-languageserver-protocol";
import { LspClient, uriFromPath, extToLanguageId } from "./client";
import { findServerForExtension } from "./server-registry";

const DIAGNOSTICS_TIMEOUT_MS = 10_000;
// How many files to look at when guessing a project's dominant language.
const EXTENSION_SAMPLE_LIMIT = 500;
// Waits before re-asking a cold language server for workspace symbols, in ms.
// Measured against typescript-language-server on this repository: a symbol in
// an unopened file stays invisible for roughly ten seconds after the server
// starts, then appears. The first entry is 0 (ask immediately); the rest total
// about ten seconds. Only a cold index pays this, and only until it answers.
const SYMBOL_INDEX_BACKOFF_MS = [0, 750, 1_250, 1_500, 2_000, 2_000, 2_500];

/** Workspace symbol results, plus whether the server's index was actually live. */
export type WorkspaceSymbolResult = {
  symbols: SymbolInformation[];
  /** False when the backoff ran out while the index was still warming up. */
  indexWarm: boolean;
};

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
  /** Languages whose symbol index has returned a result at least once. */
  private symbolIndexWarm: Set<string> = new Set();

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

  /** Symbols declared in one file. */
  async documentSymbols(
    absolutePath: string,
  ): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    const prepared = await this.prepareDocument(absolutePath);
    if (!prepared) return null;
    return prepared.client.documentSymbols(prepared.uri);
  }

  /**
   * Search symbols across the workspace.
   *
   * `workspace/symbol` is not tied to a file, which leaves an awkward
   * question this pool's per-language design does not answer on its own:
   * *which* server should be asked? The resolution:
   *
   * 1. If servers are already running, ask all of them and merge. In practice
   *    this is the common case — by the time the model wants to search
   *    symbols it has usually read or edited something.
   * 2. If none are running, sample the project to find its dominant source
   *    language and start just that one server. Starting every registered
   *    server to answer one query would be a rude way to spend a user's RAM.
   *
   * Returns `null` (rather than an empty array) when no server could be
   * started at all, so the caller can distinguish "no language server" from
   * "no matches" — two very different things to report to the model.
   */
  async workspaceSymbols(query: string): Promise<WorkspaceSymbolResult | null> {
    if (this.shuttingDown) return null;

    if (this.clients.size === 0) {
      const ext = await this.detectDominantExtension();
      if (ext) await this.clientForExt(ext);
    }
    if (this.clients.size === 0) return null;

    // A freshly started server has not finished indexing, and it answers
    // "no matches" rather than "ask me later" — measured against
    // typescript-language-server, a symbol in an unopened file is invisible
    // for roughly the first four seconds and then appears. Since an empty
    // result is genuinely ambiguous, retry with backoff, but only until this
    // language has proved its index is live. After that an empty answer is
    // taken at face value, so ordinary no-match queries stay fast.
    let merged: SymbolInformation[] = [];
    let anyAnswered = false;

    for (const [attempt, delay] of SYMBOL_INDEX_BACKOFF_MS.entries()) {
      const cold = [...this.clients.keys()].some((lang) => !this.symbolIndexWarm.has(lang));
      if (attempt > 0 && (!cold || this.shuttingDown)) break;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

      const results = await Promise.all(
        [...this.clients.entries()].map(async ([language, client]) => {
          const result = await client.workspaceSymbols(query).catch(() => null);
          if (result && result.length > 0) this.symbolIndexWarm.add(language);
          return result;
        }),
      );

      merged = [];
      anyAnswered = false;
      for (const result of results) {
        if (result === null) continue;
        anyAnswered = true;
        merged.push(...result);
      }

      if (merged.length > 0) break;
    }

    if (!anyAnswered) return null;

    // Report whether the index was actually live. An empty result from a cold
    // server means "ask again", not "this symbol does not exist" — and the
    // caller must be able to tell the model which one it is, or the model will
    // confidently conclude the symbol is absent.
    const indexWarm = [...this.clients.keys()].every((lang) => this.symbolIndexWarm.has(lang));
    return { symbols: merged, indexWarm };
  }

  /**
   * Find the file extension that best represents this project, by counting a
   * bounded sample of files that have a language server configured.
   *
   * Bounded on purpose: this runs to answer a single query, so it must not
   * turn into a full tree walk on a large repository.
   */
  private async detectDominantExtension(): Promise<string | null> {
    const counts = new Map<string, number>();
    let scanned = 0;

    try {
      const glob = new Bun.Glob("**/*");
      for await (const rel of glob.scan({
        cwd: this.workspaceRoot,
        dot: false,
        onlyFiles: true,
      })) {
        if (rel.includes("node_modules") || rel.includes(".git")) continue;
        if (++scanned > EXTENSION_SAMPLE_LIMIT) break;

        const ext = extname(rel);
        if (!ext || !findServerForExtension(ext)) continue;
        counts.set(ext, (counts.get(ext) ?? 0) + 1);
      }
    } catch {
      return null;
    }

    let best: string | null = null;
    let bestCount = 0;
    for (const [ext, count] of counts) {
      if (count > bestCount) {
        best = ext;
        bestCount = count;
      }
    }
    return best;
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
