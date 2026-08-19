import { describe, expect, test } from "bun:test";

import { htmlToMarkdown } from "./html-to-markdown";

const md = async (html: string, options?: Parameters<typeof htmlToMarkdown>[1]) =>
  (await htmlToMarkdown(html, options)).markdown;

describe("structure", () => {
  test("converts headings to Markdown", async () => {
    expect(await md("<h1>One</h1><h2>Two</h2><h3>Three</h3>")).toBe("# One\n\n## Two\n\n### Three");
  });

  test("separates paragraphs with a blank line", async () => {
    expect(await md("<p>First</p><p>Second</p>")).toBe("First\n\nSecond");
  });

  test("does not stack blank lines for nested block elements", async () => {
    // Real pages nest div in div in section; a newline per block tag would
    // produce a page that is mostly whitespace.
    const html = "<div><div><section><div><p>Deep</p></div></section></div></div>";
    expect(await md(html)).toBe("Deep");
  });

  test("renders list items tight, one per line", async () => {
    expect(await md("<ul><li>One</li><li>Two</li><li>Three</li></ul>")).toBe(
      "- One\n- Two\n- Three",
    );
  });

  test("turns <br> into a single newline", async () => {
    expect(await md("<p>a<br>b</p>")).toBe("a\nb");
  });

  test("fences <pre> and preserves its whitespace", async () => {
    const out = await md("<pre>line one\n  indented\nline three</pre>");
    expect(out).toBe("```\nline one\n  indented\nline three\n```");
  });

  test("does not add backticks to <code> inside <pre>", async () => {
    // The fence already marks it as code; backticks would nest a span in a block.
    expect(await md("<pre><code>bun test</code></pre>")).toBe("```\nbun test\n```");
  });

  test("wraps inline <code> in backticks", async () => {
    expect(await md("<p>Run <code>bun test</code> now</p>")).toBe("Run `bun test` now");
  });
});

describe("dropped subtrees", () => {
  test("drops script and style contents entirely", async () => {
    const html = "<p>Before</p><script>var secret = 1;</script><style>p{color:red}</style><p>After</p>";
    const out = await md(html);
    expect(out).not.toContain("secret");
    expect(out).not.toContain("color:red");
    expect(out).toBe("Before\n\nAfter");
  });

  test("drops nav and footer as page chrome", async () => {
    // On a docs site the sidebar can outweigh the article. HTML5 defines both
    // as non-content, so this is following the markup rather than guessing.
    const html = "<nav><a href='/x'>Sidebar</a></nav><p>Article</p><footer>© 2026</footer>";
    expect(await md(html)).toBe("Article");
  });

  test("keeps <header>, which usually holds the h1", async () => {
    expect(await md("<header><h1>Title</h1></header><p>Body</p>")).toBe("# Title\n\nBody");
  });

  test("drops nested content inside a dropped subtree", async () => {
    const html = "<nav><ul><li><a href='/a'>Deep nav link</a></li></ul></nav><p>Kept</p>";
    expect(await md(html)).toBe("Kept");
  });

  test("resumes after a dropped subtree closes", async () => {
    // A depth counter that never decremented would silently swallow the rest
    // of the page — a failure that looks like an empty site, not a bug.
    const html = "<script>x</script><p>One</p><script>y</script><p>Two</p>";
    expect(await md(html)).toBe("One\n\nTwo");
  });
});

describe("links", () => {
  test("keeps links with their text", async () => {
    expect(await md("<p>See <a href='https://x.dev/a'>the docs</a></p>")).toBe(
      "See [the docs](https://x.dev/a)",
    );
  });

  test("resolves relative hrefs against the page URL", async () => {
    // A relative link is useless to a model that wants to fetch it next — it
    // has no way to know what it was relative to.
    const out = await md("<a href='../api/x'>API</a>", {
      baseUrl: "https://docs.example.com/guide/intro",
    });
    expect(out).toBe("[API](https://docs.example.com/api/x)");
  });

  test("drops pure fragment links", async () => {
    // They point back into a page the model already has in front of it.
    expect(await md("<p>Jump to <a href='#top'>top</a></p>")).toBe("Jump to top");
  });

  test("drops javascript: and mailto: hrefs", async () => {
    expect(await md("<a href='javascript:alert(1)'>click</a>")).toBe("click");
    expect(await md("<a href='mailto:a@b.co'>mail</a>")).toBe("mail");
  });

  test("closes a link left unterminated by a truncated page", async () => {
    // Otherwise the output ends on a dangling "[" that reads as broken Markdown.
    const out = await md("<p>text <a href='https://x.dev'>label");
    expect(out).toBe("text [label](https://x.dev)");
  });
});

describe("text handling", () => {
  test("collapses source-formatting whitespace", async () => {
    expect(await md("<p>one\n   two\t\tthree</p>")).toBe("one two three");
  });

  test("keeps a single separating space between inline elements", async () => {
    expect(await md("<p><b>bold</b> <i>italic</i></p>")).toBe("bold italic");
  });

  test("keeps image alt text", async () => {
    // On a diagram or screenshot it is the only description a text model gets.
    expect(await md("<img src='/d.png' alt='Architecture diagram'>")).toBe(
      "![Architecture diagram]",
    );
  });

  test("ignores images with no alt text", async () => {
    expect(await md("<p>a</p><img src='/spacer.gif'>")).toBe("a");
  });

  test("decodes HTML entities", async () => {
    expect(await md("<p>a &amp; b &lt; c</p>")).toBe("a & b < c");
  });

  test("decodes entities inside a code block", async () => {
    // A model that copies "&lt;div&gt;" out of a docs page writes a bug.
    expect(await md("<pre>&lt;div class=&quot;x&quot;&gt;</pre>")).toBe(
      '```\n<div class="x">\n```',
    );
  });

  test("decodes entities in an href, which changes what the URL means", async () => {
    // "?a=1&amp;b=2" is how every multi-parameter link is written in HTML.
    // Left encoded, the model fetches a parameter literally named "amp;b".
    const out = await md("<a href='https://x.dev/s?a=1&amp;b=2'>q</a>");
    expect(out).toBe("[q](https://x.dev/s?a=1&b=2)");
  });
});

describe("title and truncation", () => {
  test("extracts the title and keeps it out of the body", async () => {
    const result = await htmlToMarkdown(
      "<html><head><title>Page  Name</title></head><body><p>Body</p></body></html>",
    );
    expect(result.title).toBe("Page Name");
    expect(result.markdown).toBe("Body");
  });

  test("omits the title field when the page has none", async () => {
    expect((await htmlToMarkdown("<p>Body</p>")).title).toBeUndefined();
  });

  test("reports truncation rather than silently shortening", async () => {
    const result = await htmlToMarkdown("<p>" + "x".repeat(500) + "</p>", { maxChars: 100 });
    expect(result.markdown).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  test("does not claim truncation when everything fit", async () => {
    expect((await htmlToMarkdown("<p>short</p>", { maxChars: 100 })).truncated).toBe(false);
  });
});

describe("robustness", () => {
  test("survives unclosed tags", async () => {
    expect(await md("<div><p>One<div><p>Two")).toBe("One\n\nTwo");
  });

  test("returns an empty string for an empty document", async () => {
    expect(await md("")).toBe("");
  });

  test("handles a document that is only chrome", async () => {
    expect(await md("<nav>links</nav><footer>legal</footer>")).toBe("");
  });
});
