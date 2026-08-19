import { describe, expect, test } from "bun:test";

import { decodeHtmlEntities } from "./entities";

describe("named references", () => {
  test("decodes the five XML entities", () => {
    expect(decodeHtmlEntities("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;")).toBe(
      `a & b < c > d "e" 'f'`,
    );
  });

  test("decodes typography that shows up constantly in prose", () => {
    expect(decodeHtmlEntities("&ldquo;quoted&rdquo; &mdash; and&hellip;")).toBe(
      "“quoted” — and…",
    );
  });

  test("turns &nbsp; into a normal space", () => {
    // Left as U+00A0 it survives whitespace collapsing and shows up as a
    // stray invisible character in the model's context.
    expect(decodeHtmlEntities("a&nbsp;b")).toBe("a b");
  });

  test("leaves unknown named entities exactly as they were", () => {
    // Mangling text that merely looks like an entity would be data loss; a
    // stray "&frobnicate;" is only cosmetic.
    expect(decodeHtmlEntities("&frobnicate; &notarealentity;")).toBe(
      "&frobnicate; &notarealentity;",
    );
  });

  test("is case-sensitive, as HTML is", () => {
    expect(decodeHtmlEntities("&AMP;")).toBe("&AMP;");
  });
});

describe("numeric references", () => {
  test("decodes decimal references", () => {
    expect(decodeHtmlEntities("&#39;quoted&#39;")).toBe("'quoted'");
  });

  test("decodes hex references in either case", () => {
    expect(decodeHtmlEntities("&#x27;a&#X27;")).toBe("'a'");
  });

  test("decodes astral-plane code points", () => {
    expect(decodeHtmlEntities("&#128512;")).toBe("\u{1F600}");
  });

  test("refuses surrogates rather than producing a lone half", () => {
    // Not valid scalar values; emitting one produces a string that breaks on
    // any downstream encode.
    expect(decodeHtmlEntities("&#xD800;")).toBe("&#xD800;");
  });

  test("refuses NUL and out-of-range code points", () => {
    expect(decodeHtmlEntities("&#0;")).toBe("&#0;");
    expect(decodeHtmlEntities("&#x110000;")).toBe("&#x110000;");
  });
});

describe("edges", () => {
  test("returns input untouched when there is no ampersand", () => {
    const plain = "nothing to do here";
    expect(decodeHtmlEntities(plain)).toBe(plain);
  });

  test("leaves a bare ampersand alone", () => {
    expect(decodeHtmlEntities("Tom & Jerry")).toBe("Tom & Jerry");
  });

  test("leaves an unterminated entity alone", () => {
    expect(decodeHtmlEntities("&amp and &lt")).toBe("&amp and &lt");
  });

  test("decodes repeated entities in one string", () => {
    expect(decodeHtmlEntities("&lt;div&gt;&lt;/div&gt;")).toBe("<div></div>");
  });

  test("does not re-decode its own output", () => {
    // "&amp;lt;" means the literal text "&lt;" — decoding twice would turn a
    // page that is *documenting* HTML into a page that contains it.
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
  });
});
