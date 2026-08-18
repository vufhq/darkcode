import { describe, expect, test } from "bun:test";

import { applyEdit } from "./apply-edit";
import {
  blockAnchorReplacer,
  indentationFlexibleReplacer,
  lineTrimmedReplacer,
  trimmedReplacer,
  whitespaceNormalizedReplacer,
} from "./replacers";

/**
 * The safety property every strategy must hold: it may only ever yield
 * substrings that already exist verbatim in the content. However fuzzy the
 * matching, the text being replaced is real file text — a strategy can pick the
 * wrong region, but it can never fabricate one.
 */
function assertCandidatesAreRealSubstrings(candidates: string[], content: string) {
  for (const candidate of candidates) {
    expect(content.includes(candidate)).toBe(true);
  }
}

const collect = (
  replacer: { find: (c: string, s: string) => Generator<string> },
  content: string,
  search: string,
) => {
  const out = [...replacer.find(content, search)];
  assertCandidatesAreRealSubstrings(out, content);
  return out;
};

describe("trimmedReplacer", () => {
  test("matches when the model wrapped the text in blank lines", () => {
    expect(collect(trimmedReplacer, "a\nTARGET\nb", "\nTARGET\n")).toEqual(["TARGET"]);
  });

  test("yields nothing when the trimmed form is identical", () => {
    expect(collect(trimmedReplacer, "a\nTARGET\n", "TARGET")).toEqual([]);
  });
});

describe("lineTrimmedReplacer", () => {
  test("matches through trailing whitespace in the file", () => {
    const content = "function a() {   \n  return 1;\n}\n";
    const found = collect(lineTrimmedReplacer, content, "function a() {\n  return 1;\n}");
    expect(found).toEqual(["function a() {   \n  return 1;\n}"]);
  });

  test("matches through a leading-indentation mismatch", () => {
    const content = "    const x = 1;\n";
    expect(collect(lineTrimmedReplacer, content, "const x = 1;")).toEqual(["    const x = 1;"]);
  });

  test("still requires the line contents to match in order", () => {
    const content = "a\nb\nc\n";
    expect(collect(lineTrimmedReplacer, content, "a\nc")).toEqual([]);
  });

  test("yields every match when the block is repeated", () => {
    const content = "x\n\nx\n";
    expect(collect(lineTrimmedReplacer, content, "x").length).toBe(2);
  });
});

describe("indentationFlexibleReplacer", () => {
  test("matches a block quoted at a different indentation level", () => {
    const content = "class A {\n    method() {\n        return 1;\n    }\n}\n";
    const search = "method() {\n    return 1;\n}";
    expect(collect(indentationFlexibleReplacer, content, search)).toEqual([
      "    method() {\n        return 1;\n    }",
    ]);
  });

  test("preserves relative nesting — a reshaped block does not match", () => {
    const content = "if (a) {\n    if (b) {\n        c();\n    }\n}\n";
    // Inner nesting flattened: not the same block shape.
    const search = "if (a) {\nif (b) {\nc();\n}\n}";
    expect(collect(indentationFlexibleReplacer, content, search)).toEqual([]);
  });
});

describe("whitespaceNormalizedReplacer", () => {
  test("matches a single line with collapsed internal spacing", () => {
    const content = "const  x   =    1;\n";
    expect(collect(whitespaceNormalizedReplacer, content, "const x = 1;")).toEqual([
      "const  x   =    1;",
    ]);
  });

  test("matches a multi-line block whose spacing drifted", () => {
    const content = "foo(\n   a,\n   b\n);\n";
    const found = collect(whitespaceNormalizedReplacer, content, "foo(\n  a,\n  b\n);");
    expect(found).toEqual(["foo(\n   a,\n   b\n);"]);
  });
});

describe("blockAnchorReplacer", () => {
  test("matches when the interior drifted but both anchors hold", () => {
    const content = [
      "function compute(input) {",
      "  const scaled = input * 2;",
      "  return scaled + 1;",
      "}",
    ].join("\n");
    // The model paraphrased the middle but quoted the ends correctly.
    const search = [
      "function compute(input) {",
      "  const scaled = input * 2;",
      "  return scaled+1;",
      "}",
    ].join("\n");
    expect(collect(blockAnchorReplacer, content, search)).toEqual([content]);
  });

  test("refuses blocks shorter than three lines", () => {
    expect(collect(blockAnchorReplacer, "a\nb\n", "a\nb")).toEqual([]);
  });

  test("rejects a candidate whose interior is not similar enough", () => {
    const content = ["function f() {", "  completelyDifferentThing(1, 2, 3);", "}"].join("\n");
    const search = ["function f() {", "  return databaseQuery(userId);", "}"].join("\n");
    expect(collect(blockAnchorReplacer, content, search)).toEqual([]);
  });

  test("rejects a candidate that is wildly the wrong size", () => {
    const content = ["start {", "a", "b", "c", "d", "e", "f", "g", "h", "}"].join("\n");
    const search = ["start {", "a", "}"].join("\n");
    expect(collect(blockAnchorReplacer, content, search)).toEqual([]);
  });
});

describe("applyEdit — fallback integration", () => {
  test("an exact match reports the exact strategy", () => {
    const out = applyEdit("a\nTARGET\nb\n", "TARGET", "REPLACED");
    expect(out.strategy).toBe("exact");
    expect(out.content).toBe("a\nREPLACED\nb\n");
  });

  test("recovers an edit that missed only on trailing whitespace", () => {
    const content = "function a() {   \n  return 1;\n}\n";
    const out = applyEdit(content, "function a() {\n  return 1;\n}", "function a() {\n  return 2;\n}");
    expect(out.strategy).toBe("line-trimmed");
    expect(out.content).toBe("function a() {\n  return 2;\n}\n");
  });

  test("recovers an edit quoted at the wrong indentation", () => {
    const content = "class A {\n    method() {\n        return 1;\n    }\n}\n";
    const out = applyEdit(content, "method() {\n    return 1;\n}", "method() {\n    return 2;\n}");
    expect(out.strategy).toBe("indentation-flexible");
    expect(out.content).toContain("return 2;");
    expect(out.content.startsWith("class A {")).toBe(true);
  });

  test("an ambiguous exact match still errors rather than guessing", () => {
    // The whole point: three verbatim hits means "quote more context", not
    // "let a fuzzier strategy pick one".
    expect(() => applyEdit("x\nx\nx\n", "x", "y")).toThrow("ambiguous");
  });

  test("a genuinely absent oldString still errors after every strategy", () => {
    expect(() => applyEdit("alpha\nbeta\n", "nothing like this at all", "z")).toThrow(
      "oldString not found in file",
    );
  });

  test("a fallback that finds several equal candidates does not guess", () => {
    // The search text appears nowhere verbatim (internal spacing differs), so
    // the exact stage misses. whitespace-normalized then sees two identical
    // candidate regions — it must decline rather than pick the first.
    const content = "const  x = 1;\nsomething else\nconst  x = 1;\n";
    expect(() => applyEdit(content, "const x = 1;", "const x = 2;")).toThrow(
      "oldString not found in file",
    );
  });

  test("fallback matching still respects CRLF files", () => {
    const content = "function a() {   \r\n  return 1;\r\n}\r\n";
    const out = applyEdit(content, "function a() {\n  return 1;\n}", "function a() {\n  return 2;\n}");
    expect(out.strategy).toBe("line-trimmed");
    expect(out.content).toBe("function a() {\r\n  return 2;\r\n}\r\n");
  });

  test("fallback matching still treats the replacement as literal data", () => {
    // Internal spacing differs, so this only matches via a fallback — and the
    // `$$` must survive that path just as it does the exact one.
    const content = "  cost   =   OLD;\n";
    const out = applyEdit(content, "cost = OLD;", "cost = $$;");
    expect(out.strategy).toBe("whitespace-normalized");
    expect(out.content).toBe("cost = $$;\n");
  });

  test("an exact hit splices only the matched text, not the whole line", () => {
    // `TARGET` is present verbatim, so the surrounding whitespace on that line
    // is untouched — fuzzy matching never gets involved.
    const content = "keep-a\n    TARGET   \nkeep-b\n";
    const out = applyEdit(content, "TARGET", "DONE");
    expect(out.strategy).toBe("exact");
    expect(out.content).toBe("keep-a\n    DONE   \nkeep-b\n");
  });
});
