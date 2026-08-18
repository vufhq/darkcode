import { describe, expect, test } from "bun:test";

import {
  applyLineEnding,
  detectLineEnding,
  joinBom,
  normalizedIndexToRaw,
  normalizeNewlines,
  spliceRange,
  splitBom,
  splitLines,
} from "./text";

describe("splitLines (finding 03)", () => {
  test("does not leave a trailing `\\r` on CRLF input", () => {
    // This is the whole bug: `"a\r\nb".split("\n")` yields ["a\r", "b"], and
    // that `\r` then breaks `$`-anchored matching and travels into the model's
    // context as an invisible control character.
    expect(splitLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
  });

  test("handles LF input identically", () => {
    expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  test("handles mixed input", () => {
    expect(splitLines("a\r\nb\nc\r\nd")).toEqual(["a", "b", "c", "d"]);
  });

  test("a `$`-anchored pattern matches a CRLF line after splitting", () => {
    const [first] = splitLines("const x = 1;\r\nconst y = 2;\r\n");
    expect(/;$/.test(first!)).toBe(true);
  });

  test("preserves a lone `\\r` inside a line as data", () => {
    expect(splitLines("progress\rdone\nnext")).toEqual(["progress\rdone", "next"]);
  });

  test("a trailing newline produces a trailing empty element", () => {
    // Documented rather than "fixed" — callers depend on this to distinguish a
    // file that ends in a newline from one that does not.
    expect(splitLines("a\r\n")).toEqual(["a", ""]);
  });
});

describe("detectLineEnding", () => {
  test("reports LF for LF-only text", () => {
    expect(detectLineEnding("a\nb\nc\n")).toBe("\n");
  });

  test("reports CRLF for CRLF-only text", () => {
    expect(detectLineEnding("a\r\nb\r\nc\r\n")).toBe("\r\n");
  });

  test("goes with the majority in a mixed file", () => {
    // One stray CRLF should not make an otherwise-LF file 'a CRLF file'.
    expect(detectLineEnding("a\nb\nc\nd\r\n")).toBe("\n");
    expect(detectLineEnding("a\r\nb\r\nc\r\nd\n")).toBe("\r\n");
  });

  test("breaks a tie toward LF", () => {
    expect(detectLineEnding("a\r\nb\n")).toBe("\n");
  });

  test("defaults to LF for text with no line breaks at all", () => {
    expect(detectLineEnding("single line")).toBe("\n");
  });
});

describe("normalizeNewlines / applyLineEnding", () => {
  test("normalize collapses CRLF to LF", () => {
    expect(normalizeNewlines("a\r\nb")).toBe("a\nb");
  });

  test("normalize leaves a lone `\\r` alone", () => {
    expect(normalizeNewlines("a\rb")).toBe("a\rb");
  });

  test("applying CRLF does not double up on already-CRLF text", () => {
    // The naive `replaceAll("\n", "\r\n")` on CRLF input yields `\r\r\n`.
    expect(applyLineEnding("a\r\nb", "\r\n")).toBe("a\r\nb");
  });

  test("normalize then apply is a round trip in both directions", () => {
    const crlf = "a\r\nb\r\nc";
    expect(applyLineEnding(normalizeNewlines(crlf), "\r\n")).toBe(crlf);
    const lf = "a\nb\nc";
    expect(applyLineEnding(normalizeNewlines(lf), "\n")).toBe(lf);
  });
});

describe("splitBom / joinBom", () => {
  test("splits a leading BOM off", () => {
    expect(splitBom("﻿hello")).toEqual({ bom: true, body: "hello" });
  });

  test("leaves BOM-less text untouched", () => {
    expect(splitBom("hello")).toEqual({ bom: false, body: "hello" });
  });

  test("only the leading BOM is stripped, not a U+FEFF later in the text", () => {
    expect(splitBom("a﻿b").body).toBe("a﻿b");
  });

  test("split then join is a round trip", () => {
    for (const input of ["﻿hello", "hello"]) {
      const { bom, body } = splitBom(input);
      expect(joinBom(body, bom)).toBe(input);
    }
  });
});

describe("normalizedIndexToRaw", () => {
  test("is the identity when there is nothing to normalize", () => {
    expect(normalizedIndexToRaw("abcdef", 3)).toBe(3);
  });

  test("shifts by one for each preceding CRLF pair", () => {
    // raw:        a \r \n b \r \n c
    // normalized: a       \n b     \n c   → 'c' is at normalized 4, raw 6
    expect(normalizedIndexToRaw("a\r\nb\r\nc", 4)).toBe(6);
  });

  test("maps index 0 to index 0", () => {
    expect(normalizedIndexToRaw("\r\nabc", 0)).toBe(0);
  });

  test("maps a position past the end to the raw length", () => {
    expect(normalizedIndexToRaw("a\r\nb", 99)).toBe(4);
  });

  test("does not shift for a lone `\\r`, which normalization keeps", () => {
    expect(normalizedIndexToRaw("a\rb", 2)).toBe(2);
  });

  test("agrees with a slice taken in normalized space", () => {
    // The property that matters: slicing raw at the mapped offsets yields the
    // same text as slicing normalized at the original offsets (modulo the
    // dropped `\r`).
    const raw = "one\r\ntwo\r\nthree";
    const normalized = normalizeNewlines(raw);
    const at = normalized.indexOf("three");
    expect(raw.slice(normalizedIndexToRaw(raw, at))).toBe("three");
  });
});

describe("spliceRange (finding 01)", () => {
  test("treats the replacement as literal data", () => {
    // The point of the function: no interpretation step, so no token in the
    // replacement can mean anything.
    for (const token of ["$&", "$$", "$'", "$`", "$1", "$<name>"]) {
      expect(spliceRange("A OLD B", 2, 5, token)).toBe(`A ${token} B`);
    }
  });

  test("inserts when the range is empty", () => {
    expect(spliceRange("ab", 1, 1, "X")).toBe("aXb");
  });

  test("deletes when the replacement is empty", () => {
    expect(spliceRange("abc", 1, 2, "")).toBe("ac");
  });
});
