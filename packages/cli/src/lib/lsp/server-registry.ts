/**
 * LSP server registry — maps file extensions to language-server launch configs.
 * Adding a new language = adding an entry here; no code fork needed.
 */

export interface ServerEntry {
  /** Human-readable language name used in logs. */
  language: string;
  /** Executable name (resolved via PATH). */
  command: string;
  /** Arguments passed to the binary. */
  args: string[];
  /** File extensions (without leading dot) this server handles. */
  extensions: string[];
}

/**
 * Known language servers in priority order.
 * The first entry whose extensions contain the requested extension is used.
 *
 * Only launch a server when a file of that language is actually requested
 * (lazy, not eager on startup).
 */
export const SERVER_REGISTRY: ServerEntry[] = [
  {
    language: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
  },
  {
    language: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: ["py", "pyi"],
  },
  {
    language: "rust",
    command: "rust-analyzer",
    args: [],
    extensions: ["rs"],
  },
  {
    language: "go",
    command: "gopls",
    args: [],
    extensions: ["go"],
  },
];

export function findServerForExtension(ext: string): ServerEntry | undefined {
  const bare = ext.startsWith(".") ? ext.slice(1) : ext;
  return SERVER_REGISTRY.find((s) => s.extensions.includes(bare));
}
