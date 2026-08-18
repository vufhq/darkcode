import { describe, expect, test } from "bun:test";

import { applyEdit } from "./apply-edit";

/**
 * These are *regression* tests: each one pins a bug that actually shipped, so
 * that a future refactor which reintroduces it fails here instead of silently
 * corrupting a user's file. The distinguishing feature of a regression test is
 * that it is written against a known-bad behavior — you confirm it fails on
 * the old code before you trust it on the new code. A test that has never
 * failed has not yet proved it can detect anything.
 */

describe("applyEdit — dollar-sign replacements (finding 01)", () => {
  // The old implementation used `content.replace(oldString, newString)`, and
  // `String.replace` scans the *replacement* for substitution patterns even
  // when the pattern is a plain string. Each case below silently produced the
  // wrong bytes while reporting success.

  test("`$&` is written literally, not expanded to the matched text", () => {
    const out = applyEdit('const price = OLD;\n', "OLD", 'cost.replace(/x/, "$&y")');
    expect(out.content).toBe('const price = cost.replace(/x/, "$&y");\n');
    // The specific old failure: `$&` expanded to the matched substring.
    expect(out.content).not.toContain("OLDy");
  });

  test("`$$` is written literally, not collapsed to a single `$`", () => {
    const out = applyEdit("echo OLD\n", "OLD", "PID is $$");
    expect(out.content).toBe("echo PID is $$\n");
  });

  test("``$` `` is written literally, not expanded to the file prefix", () => {
    const out = applyEdit("A OLD B", "OLD", "x$`y");
    expect(out.content).toBe("A x$`y B");
  });

  test("`$'` is written literally, not expanded to the file suffix", () => {
    const out = applyEdit("A OLD B", "OLD", "x$'y");
    expect(out.content).toBe("A x$'y B");
  });

  test("a replacement that is only dollar signs survives intact", () => {
    const out = applyEdit("cost = OLD\n", "OLD", "$$$$");
    expect(out.content).toBe("cost = $$$$\n");
  });

  test("`$1` survives (it was already safe, and must stay safe)", () => {
    const out = applyEdit("let x = OLD;\n", "OLD", 'v.replace(re, "$1-$2")');
    expect(out.content).toBe('let x = v.replace(re, "$1-$2");\n');
  });

  test("a realistic shell-script edit round-trips exactly", () => {
    const before = "#!/bin/sh\nLOCK=/tmp/old.lock\n";
    const out = applyEdit(before, "/tmp/old.lock", '/tmp/app-$$.lock');
    expect(out.content).toBe("#!/bin/sh\nLOCK=/tmp/app-$$.lock\n");
  });
});

describe("applyEdit — line endings (finding 02)", () => {
  // The old implementation matched the model's LF-delimited `oldString`
  // against raw CRLF file contents, so every multi-line edit to a Windows file
  // threw "oldString not found in file".

  test("a multi-line LF oldString matches a CRLF file", () => {
    const crlf = "function a() {\r\n  return 1;\r\n}\r\n";
    const out = applyEdit(crlf, "function a() {\n  return 1;\n}", "function a() {\n  return 2;\n}");
    expect(out.crlf).toBe(true);
    // The replacement comes back in the file's own convention, not the model's.
    expect(out.content).toBe("function a() {\r\n  return 2;\r\n}\r\n");
  });

  test("a CRLF file gains no LF-only lines from the replacement", () => {
    const crlf = "a\r\nOLD\r\nz\r\n";
    const out = applyEdit(crlf, "OLD", "one\ntwo\nthree");
    expect(out.content).toBe("a\r\none\r\ntwo\r\nthree\r\nz\r\n");
    // No bare LF anywhere: every \n must be preceded by \r.
    expect(/(?<!\r)\n/.test(out.content)).toBe(false);
  });

  test("an LF file stays LF (control case)", () => {
    const lf = "function a() {\n  return 1;\n}\n";
    const out = applyEdit(lf, "function a() {\n  return 1;\n}", "function a() {\n  return 2;\n}");
    expect(out.crlf).toBe(false);
    expect(out.content).toBe("function a() {\n  return 2;\n}\n");
  });

  test("a CRLF oldString also matches a CRLF file", () => {
    // The model usually emits LF, but if it echoes back exactly what it read
    // we must not regress into a double-normalization mismatch.
    const crlf = "x\r\nOLD\r\ny\r\n";
    const out = applyEdit(crlf, "OLD\r\ny", "NEW\r\ny");
    expect(out.content).toBe("x\r\nNEW\r\ny\r\n");
  });

  test("a mixed-ending file is edited surgically, not rewritten", () => {
    // Three CRLF lines and one LF line: CRLF dominates, so the inserted text
    // gets CRLF — but the untouched LF line must survive untouched. The naive
    // "normalize everything, edit, convert everything back" approach fails
    // here by rewriting line 4 as well.
    const mixed = "a\r\nb\r\nOLD\r\nkeep-lf\n";
    const out = applyEdit(mixed, "OLD", "NEW");
    expect(out.content).toBe("a\r\nb\r\nNEW\r\nkeep-lf\n");
  });

  test("an edit after a CRLF run lands at the right offset", () => {
    // Directly exercises the normalized→raw index mapping: the match is
    // preceded by CRLF pairs, so the raw offset is larger than the normalized
    // one by exactly the number of dropped `\r` characters.
    const crlf = "1\r\n2\r\n3\r\nTARGET\r\n5\r\n";
    const out = applyEdit(crlf, "TARGET", "HIT");
    expect(out.content).toBe("1\r\n2\r\n3\r\nHIT\r\n5\r\n");
  });

  test("a lone `\\r` is treated as data and left alone", () => {
    // Not a line ending — a carriage return inside a captured log line.
    const withCr = "progress: 10%\rprogress: 50%\nOLD\n";
    const out = applyEdit(withCr, "OLD", "NEW");
    expect(out.content).toBe("progress: 10%\rprogress: 50%\nNEW\n");
  });
});

describe("applyEdit — byte-order marks", () => {
  test("an edit anchored to the first line matches past the BOM", () => {
    const withBom = "﻿first line\nsecond line\n";
    const out = applyEdit(withBom, "first line", "FIRST LINE");
    expect(out.content).toBe("﻿FIRST LINE\nsecond line\n");
  });

  test("the BOM is preserved rather than dropped", () => {
    const withBom = "﻿a\nOLD\n";
    expect(applyEdit(withBom, "OLD", "NEW").content.startsWith("﻿")).toBe(true);
  });

  test("a BOM is not invented for a file that had none", () => {
    expect(applyEdit("a\nOLD\n", "OLD", "NEW").content.startsWith("﻿")).toBe(false);
  });

  test("a BOM-prefixed CRLF file round-trips both properties", () => {
    const out = applyEdit("﻿a\r\nOLD\r\n", "OLD", "NEW");
    expect(out.content).toBe("﻿a\r\nNEW\r\n");
  });
});

describe("applyEdit — match failures", () => {
  test("reports a missing oldString with the original message", () => {
    expect(() => applyEdit("abc\n", "zzz", "yyy")).toThrow("oldString not found in file");
  });

  test("reports an ambiguous oldString with the match count", () => {
    expect(() => applyEdit("x\nx\nx\n", "x", "y")).toThrow("oldString is ambiguous; found 3 matches");
  });

  test("ambiguity is judged after normalization, not before", () => {
    // Both occurrences are CRLF on disk; the LF oldString must still see two.
    const crlf = "a\r\nDUP\r\nb\r\nDUP\r\n";
    expect(() => applyEdit(crlf, "DUP", "X")).toThrow("found 2 matches");
  });

  test("overlapping candidates are counted non-overlapping", () => {
    // "aaaa" contains "aa" twice without overlap, not three times with.
    expect(() => applyEdit("aaaa", "aa", "b")).toThrow("found 2 matches");
  });

  test("rejects an empty oldString instead of looping", () => {
    expect(() => applyEdit("abc", "", "x")).toThrow("oldString must not be empty");
  });
});

describe("applyEdit — general correctness", () => {
  test("replaces only the first and only match, leaving the rest byte-identical", () => {
    const before = "header\nunique-token\nfooter\n";
    const out = applyEdit(before, "unique-token", "replaced");
    expect(out.content).toBe("header\nreplaced\nfooter\n");
  });

  test("an empty newString deletes the matched text", () => {
    expect(applyEdit("keep REMOVE keep", "REMOVE ", "").content).toBe("keep keep");
  });

  test("a match at the very start of the file is handled", () => {
    expect(applyEdit("OLD rest", "OLD", "NEW").content).toBe("NEW rest");
  });

  test("a match at the very end of the file is handled", () => {
    expect(applyEdit("rest OLD", "OLD", "NEW").content).toBe("rest NEW");
  });

  test("a match spanning the entire file is handled", () => {
    expect(applyEdit("OLD", "OLD", "NEW").content).toBe("NEW");
  });

  test("unicode content is not mangled", () => {
    const out = applyEdit("const emoji = 'OLD';\n", "OLD", "🎯 café — naïve");
    expect(out.content).toBe("const emoji = '🎯 café — naïve';\n");
  });
});
