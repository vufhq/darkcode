import type { DocumentSymbol, SymbolInformation } from "vscode-languageserver-protocol";

/**
 * Normalizes LSP symbol results into one flat, model-friendly shape.
 *
 * The protocol allows two entirely different answers to the same question.
 * `textDocument/documentSymbol` may return nested `DocumentSymbol[]` (a tree,
 * with `range`/`selectionRange` and `children`) or flat `SymbolInformation[]`
 * (each carrying a `Location` and a `containerName` string) — a server picks
 * based on the client capability it saw, and older ones ignore the capability
 * and send the flat form anyway. `workspace/symbol` always returns the flat
 * form. Rather than making every caller handle three cases, everything is
 * converted here.
 *
 * Pure by design: no LSP connection, no filesystem. The awkward part of this
 * feature is the shape-juggling, not the I/O, so the shape-juggling is what
 * gets tested.
 */

/** `SymbolKind` numbers from the LSP spec, as readable labels. */
const SYMBOL_KIND_LABELS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-parameter",
};

export function symbolKindLabel(kind: number | undefined): string {
  return (kind !== undefined && SYMBOL_KIND_LABELS[kind]) || "unknown";
}

/** One symbol, flattened. */
export type FlatSymbol = {
  name: string;
  kind: string;
  /** Dotted path of enclosing symbols, e.g. `LspPool.clientForExt`. */
  container?: string;
  /** Project-relative path, filled in by the caller that knows the root. */
  file?: string;
  /** 1-based, to match how every other tool reports line numbers. */
  line: number;
  /** 0-based, to match LSP positions used by the other lsp* tools. */
  character: number;
  /** Server-supplied extra, typically a signature. */
  detail?: string;
};

/** Distinguish the two response shapes structurally. */
function isSymbolInformation(
  symbol: DocumentSymbol | SymbolInformation,
): symbol is SymbolInformation {
  return "location" in symbol;
}

export type FlattenOptions = {
  /** Stop after this many symbols. */
  limit?: number;
  /** Resolve a document URI to a display path. */
  toDisplayPath?: (uri: string) => string;
};

/**
 * Flatten a documentSymbol response into an ordered list.
 *
 * Nesting becomes a dotted `container`, so a method reads as
 * `LspPool.clientForExt` rather than a bare `clientForExt` the model then has
 * to go and disambiguate. Position comes from `selectionRange` (the symbol's
 * *name*) rather than `range` (its whole body), because the point of returning
 * a position is to feed it straight back into `lspHover` or `lspReferences`,
 * and those want the identifier.
 */
export function flattenDocumentSymbols(
  symbols: DocumentSymbol[] | SymbolInformation[] | null | undefined,
  options: FlattenOptions = {},
): FlatSymbol[] {
  const out: FlatSymbol[] = [];
  if (!symbols || symbols.length === 0) return out;

  const limit = options.limit ?? Infinity;

  const visit = (symbol: DocumentSymbol, prefix: string | undefined) => {
    if (out.length >= limit) return;

    const position = symbol.selectionRange?.start ?? symbol.range?.start;
    const entry: FlatSymbol = {
      name: symbol.name,
      kind: symbolKindLabel(symbol.kind),
      line: (position?.line ?? 0) + 1,
      character: position?.character ?? 0,
    };
    if (prefix) entry.container = prefix;
    if (symbol.detail) entry.detail = symbol.detail;
    out.push(entry);

    if (symbol.children) {
      const childPrefix = prefix ? `${prefix}.${symbol.name}` : symbol.name;
      for (const child of symbol.children) visit(child, childPrefix);
    }
  };

  for (const symbol of symbols) {
    if (out.length >= limit) break;

    if (isSymbolInformation(symbol)) {
      out.push(flattenSymbolInformation(symbol, options.toDisplayPath));
      continue;
    }
    visit(symbol, undefined);
  }

  return out.slice(0, limit === Infinity ? undefined : limit);
}

/** Flatten one `SymbolInformation`, which already carries its own location. */
export function flattenSymbolInformation(
  symbol: SymbolInformation,
  toDisplayPath?: (uri: string) => string,
): FlatSymbol {
  const start = symbol.location?.range?.start;
  const entry: FlatSymbol = {
    name: symbol.name,
    kind: symbolKindLabel(symbol.kind),
    line: (start?.line ?? 0) + 1,
    character: start?.character ?? 0,
  };
  if (symbol.containerName) entry.container = symbol.containerName;
  if (symbol.location?.uri) {
    entry.file = toDisplayPath ? toDisplayPath(symbol.location.uri) : symbol.location.uri;
  }
  return entry;
}

/**
 * Flatten a workspace/symbol response, which is always the flat shape.
 *
 * Merging results from several language servers can surface the same symbol
 * twice (a monorepo where two servers both claim a file), so identical entries
 * are collapsed.
 */
export function flattenWorkspaceSymbols(
  symbols: SymbolInformation[] | null | undefined,
  options: FlattenOptions = {},
): FlatSymbol[] {
  if (!symbols || symbols.length === 0) return [];

  const seen = new Set<string>();
  const out: FlatSymbol[] = [];
  const limit = options.limit ?? Infinity;

  for (const symbol of symbols) {
    if (out.length >= limit) break;
    const entry = flattenSymbolInformation(symbol, options.toDisplayPath);
    const key = `${entry.file ?? ""}:${entry.line}:${entry.character}:${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }

  return out;
}
