import { describe, expect, test } from "bun:test";
import type { DocumentSymbol, SymbolInformation } from "vscode-languageserver-protocol";

import { pathFromUri, uriFromPath } from "./client";
import { flattenDocumentSymbols, flattenWorkspaceSymbols, symbolKindLabel } from "./symbols";

const range = (line: number, character = 0) => ({
  start: { line, character },
  end: { line, character: character + 1 },
});

/** A hierarchical `DocumentSymbol`, the shape modern servers return. */
const docSymbol = (
  name: string,
  kind: number,
  line: number,
  children?: DocumentSymbol[],
): DocumentSymbol => ({
  name,
  kind: kind as DocumentSymbol["kind"],
  range: range(line),
  selectionRange: range(line, 6),
  ...(children ? { children } : {}),
});

/** A flat `SymbolInformation`, the shape older servers and workspace/symbol use. */
const infoSymbol = (
  name: string,
  kind: number,
  uri: string,
  line: number,
  containerName?: string,
): SymbolInformation => ({
  name,
  kind: kind as SymbolInformation["kind"],
  location: { uri, range: range(line) },
  ...(containerName ? { containerName } : {}),
});

describe("symbolKindLabel", () => {
  test("maps the LSP kind numbers to readable labels", () => {
    expect(symbolKindLabel(5)).toBe("class");
    expect(symbolKindLabel(6)).toBe("method");
    expect(symbolKindLabel(12)).toBe("function");
    expect(symbolKindLabel(11)).toBe("interface");
  });

  test("degrades to 'unknown' for an unmapped or missing kind", () => {
    expect(symbolKindLabel(99)).toBe("unknown");
    expect(symbolKindLabel(undefined)).toBe("unknown");
  });
});

describe("flattenDocumentSymbols — hierarchical shape", () => {
  test("returns an empty list for no symbols", () => {
    expect(flattenDocumentSymbols([])).toEqual([]);
    expect(flattenDocumentSymbols(null)).toEqual([]);
    expect(flattenDocumentSymbols(undefined)).toEqual([]);
  });

  test("flattens a nested tree depth-first", () => {
    const tree = [
      docSymbol("LspPool", 5, 10, [docSymbol("clientForExt", 6, 20), docSymbol("shutdownAll", 6, 30)]),
    ];
    expect(flattenDocumentSymbols(tree).map((s) => s.name)).toEqual([
      "LspPool",
      "clientForExt",
      "shutdownAll",
    ]);
  });

  test("builds a dotted container path from the nesting", () => {
    const tree = [docSymbol("LspPool", 5, 10, [docSymbol("clientForExt", 6, 20)])];
    const flat = flattenDocumentSymbols(tree);
    expect(flat[0]!.container).toBeUndefined();
    expect(flat[1]!.container).toBe("LspPool");
  });

  test("nests containers more than one level deep", () => {
    const tree = [docSymbol("Outer", 5, 1, [docSymbol("Inner", 5, 2, [docSymbol("deep", 6, 3)])])];
    expect(flattenDocumentSymbols(tree).map((s) => s.container)).toEqual([
      undefined,
      "Outer",
      "Outer.Inner",
    ]);
  });

  test("reports 1-based lines to match every other tool", () => {
    // LSP is 0-based; grep, readFile and the UI are all 1-based.
    expect(flattenDocumentSymbols([docSymbol("x", 12, 0)])[0]!.line).toBe(1);
    expect(flattenDocumentSymbols([docSymbol("x", 12, 41)])[0]!.line).toBe(42);
  });

  test("positions on the symbol name, not the start of its body", () => {
    // selectionRange is the identifier; range is the whole declaration. The
    // returned position gets fed back into lspHover/lspReferences, which want
    // the identifier.
    const symbol: DocumentSymbol = {
      name: "compute",
      kind: 12 as DocumentSymbol["kind"],
      range: { start: { line: 5, character: 0 }, end: { line: 9, character: 1 } },
      selectionRange: { start: { line: 5, character: 9 }, end: { line: 5, character: 16 } },
    };
    const flat = flattenDocumentSymbols([symbol])[0]!;
    expect(flat.character).toBe(9);
  });

  test("falls back to range when selectionRange is absent", () => {
    const symbol = {
      name: "x",
      kind: 12,
      range: { start: { line: 3, character: 4 }, end: { line: 3, character: 5 } },
    } as unknown as DocumentSymbol;
    const flat = flattenDocumentSymbols([symbol])[0]!;
    expect(flat.line).toBe(4);
    expect(flat.character).toBe(4);
  });

  test("carries the server's detail through", () => {
    const symbol = { ...docSymbol("run", 6, 1), detail: "(): Promise<void>" };
    expect(flattenDocumentSymbols([symbol])[0]!.detail).toBe("(): Promise<void>");
  });

  test("respects the limit, including across nesting", () => {
    const tree = [docSymbol("A", 5, 1, [docSymbol("b", 6, 2), docSymbol("c", 6, 3)])];
    expect(flattenDocumentSymbols(tree, { limit: 2 }).map((s) => s.name)).toEqual(["A", "b"]);
  });
});

describe("flattenDocumentSymbols — flat shape", () => {
  test("accepts SymbolInformation from a server that ignored our capability", () => {
    // Older servers send the flat form regardless of what the client asked
    // for, so both shapes must work through the same entry point.
    const flat = flattenDocumentSymbols([
      infoSymbol("helper", 12, uriFromPath("/proj/src/a.ts"), 4, "Utils"),
    ]);
    expect(flat).toHaveLength(1);
    expect(flat[0]!.name).toBe("helper");
    expect(flat[0]!.container).toBe("Utils");
    expect(flat[0]!.line).toBe(5);
  });
});

describe("flattenWorkspaceSymbols", () => {
  test("resolves file URIs through the display-path mapper", () => {
    const flat = flattenWorkspaceSymbols([infoSymbol("Thing", 5, "file:///proj/src/a.ts", 0)], {
      toDisplayPath: (uri) => pathFromUri(uri).replace("/proj/", ""),
    });
    expect(flat[0]!.file).toBe("src/a.ts");
  });

  test("collapses duplicates from several servers claiming one file", () => {
    const one = infoSymbol("Shared", 5, "file:///proj/a.ts", 3);
    expect(flattenWorkspaceSymbols([one, { ...one }])).toHaveLength(1);
  });

  test("keeps same-named symbols that live in different places", () => {
    const a = infoSymbol("Config", 5, "file:///proj/a.ts", 3);
    const b = infoSymbol("Config", 5, "file:///proj/b.ts", 3);
    expect(flattenWorkspaceSymbols([a, b])).toHaveLength(2);
  });

  test("respects the limit", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      infoSymbol(`S${i}`, 5, `file:///proj/f${i}.ts`, i),
    );
    expect(flattenWorkspaceSymbols(many, { limit: 3 })).toHaveLength(3);
  });

  test("returns an empty list for a null response", () => {
    expect(flattenWorkspaceSymbols(null)).toEqual([]);
  });
});

describe("pathFromUri", () => {
  test("round-trips a POSIX path", () => {
    expect(pathFromUri(uriFromPath("/home/dev/a.ts"))).toBe("/home/dev/a.ts");
  });

  test("round-trips a Windows path", () => {
    expect(pathFromUri(uriFromPath("C:\\proj\\a.ts"))).toBe("C:/proj/a.ts");
  });

  test("decodes percent-escapes so the path exists on disk", () => {
    // Servers percent-encode; naive slicing would yield "my%20project".
    expect(pathFromUri("file:///home/my%20project/a.ts")).toBe("/home/my project/a.ts");
  });

  test("leaves a non-file URI alone", () => {
    expect(pathFromUri("untitled:Untitled-1")).toBe("untitled:Untitled-1");
  });

  test("survives a malformed escape rather than throwing", () => {
    expect(() => pathFromUri("file:///bad%ZZ/path")).not.toThrow();
  });
});
