import { decodeHtmlEntities } from "./entities";

/**
 * Convert an HTML page to Markdown-ish plain text for a model to read.
 *
 * ## Why not a DOM library
 *
 * The usual answer is `jsdom` + `turndown`, which is several megabytes of
 * dependency and builds a full document tree in memory before emitting a
 * single character. Bun ships `HTMLRewriter` — the same streaming parser
 * Cloudflare Workers use — so the conversion can be done with no dependency
 * at all, in one pass, without ever materializing the document.
 *
 * The trade-off is that a streaming parser has no tree to walk: handlers fire
 * as tags stream past, so anything that depends on *context* (am I inside a
 * `<script>`? inside a `<pre>`?) has to be tracked by hand with depth
 * counters. That is what most of this file is.
 *
 * ## What it aims for
 *
 * Not fidelity — legibility and token economy. A model reading a docs page
 * needs the prose, the headings that structure it, the code blocks, and the
 * links it might want to follow next. It does not need the class attributes,
 * the cookie banner, or the 200-entry sidebar.
 */

/**
 * Subtrees dropped entirely, contents and all.
 *
 * `script`/`style`/`noscript`/`svg`/`template` are never prose. `nav` and
 * `footer` are dropped because HTML5 defines them as page chrome rather than
 * content, and on a typical documentation site they are the single largest
 * source of noise — a sidebar of 200 links can outweigh the article itself.
 * `header` is deliberately NOT dropped: it frequently holds the `<h1>`.
 * `head` is dropped as a subtree, but `<title>` is pulled out of it first and
 * returned separately — it is the page's own name for itself, which is worth
 * more as a labelled field than as a stray line of body text.
 */
const DROPPED = "head, script, style, noscript, svg, iframe, template, nav, footer, form";

/** Tags that start a new block; the value is the Markdown prefix, if any. */
const BLOCK_PREFIX: Record<string, string> = {
  h1: "# ",
  h2: "## ",
  h3: "### ",
  h4: "#### ",
  h5: "##### ",
  h6: "###### ",
  li: "- ",
  blockquote: "> ",
};

const BLOCK_TAGS =
  "p, div, section, article, main, aside, li, ul, ol, tr, table, " +
  "h1, h2, h3, h4, h5, h6, blockquote, pre, hr, br, dt, dd";

export type HtmlToMarkdownOptions = {
  /** Absolute base for resolving relative hrefs, so links stay followable. */
  baseUrl?: string;
  /** Stop converting once the output passes this many characters. */
  maxChars?: number;
};

export type HtmlToMarkdownResult = {
  markdown: string;
  /** Contents of `<title>`, if the page had one. */
  title?: string;
  /** True when `maxChars` cut the output short. */
  truncated: boolean;
};

/**
 * Resolve an href against the page URL.
 *
 * A relative link is useless to a model that wants to fetch it next — it has
 * no way to know what it was relative to. Resolving here is the only place
 * that context still exists.
 */
function absolutize(href: string, baseUrl: string | undefined): string | null {
  // Decoded before parsing: `?a=1&amp;b=2` is how essentially every
  // multi-parameter link is written in HTML, and fetching it verbatim asks
  // the server for a parameter named "amp;b".
  const trimmed = decodeHtmlEntities(href).trim();
  if (!trimmed) return null;
  // Pure fragments point back into a page the model already has.
  if (trimmed.startsWith("#")) return null;
  if (/^(javascript|mailto|data):/i.test(trimmed)) return null;
  if (!baseUrl) return trimmed;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

export async function htmlToMarkdown(
  html: string,
  options: HtmlToMarkdownOptions = {},
): Promise<HtmlToMarkdownResult> {
  const { baseUrl, maxChars } = options;

  const out: string[] = [];
  let length = 0;
  /** >0 while inside a dropped subtree. Nested drops are why it is a count. */
  let dropDepth = 0;
  /** >0 while inside `<pre>`, where whitespace is significant. */
  let preDepth = 0;
  /** Set while inside an `<a>` whose href we intend to emit. */
  let pendingLinkHref: string | null = null;
  let title = "";

  const emit = (text: string) => {
    if (text.length === 0) return;
    out.push(text);
    length += text.length;
  };

  /**
   * Start a new block without stacking blank lines.
   *
   * Real HTML nests `div` inside `div` inside `section`, so a naive
   * "push \n\n on every block tag" produces pages that are mostly whitespace.
   * Looking at what was already emitted collapses those runs.
   */
  const startBlock = (prefix = "", tight = false) => {
    let tail = "";
    for (let i = out.length - 1; i >= 0 && tail.length < 2; i--) {
      tail = out[i]!.slice(-2) + tail;
    }
    if (out.length > 0) {
      if (tight) {
        if (!tail.endsWith("\n")) emit("\n");
      } else if (!tail.endsWith("\n\n")) {
        emit(tail.endsWith("\n") ? "\n" : "\n\n");
      }
    }
    emit(prefix);
  };

  const rewriter = new HTMLRewriter()
    // Registered first so a dropped subtree is known to be dropped before any
    // other handler for the same element runs.
    .on(DROPPED, {
      element(el) {
        dropDepth++;
        el.onEndTag(() => {
          dropDepth--;
        });
      },
    })
    .on(BLOCK_TAGS, {
      element(el) {
        if (dropDepth > 0) return;
        const tag = el.tagName.toLowerCase();

        if (tag === "br") {
          emit("\n");
          return;
        }
        if (tag === "hr") {
          startBlock("---");
          return;
        }
        if (tag === "pre") {
          preDepth++;
          startBlock("```\n");
          el.onEndTag(() => {
            preDepth--;
            emit("\n```");
          });
          return;
        }

        // List items are set tight — one newline, not a blank line between
        // each. A 40-item list double-spaced is 40 wasted lines of context.
        startBlock(BLOCK_PREFIX[tag] ?? "", tag === "li" || tag === "dt" || tag === "dd");
      },
    })
    .on("a", {
      element(el) {
        if (dropDepth > 0 || preDepth > 0) return;
        const href = absolutize(el.getAttribute("href") ?? "", baseUrl);
        if (!href) return;
        pendingLinkHref = href;
        emit("[");
        el.onEndTag(() => {
          emit(`](${href})`);
          pendingLinkHref = null;
        });
      },
    })
    .on("code", {
      element(el) {
        // Inside `<pre>` the fence already marks it as code; adding backticks
        // would nest a code span inside a code block.
        if (dropDepth > 0 || preDepth > 0) return;
        emit("`");
        el.onEndTag(() => emit("`"));
      },
    })
    .on("img", {
      element(el) {
        if (dropDepth > 0) return;
        // Alt text is the only part of an image a text model can use, and on
        // diagrams and screenshots it is often the only description present.
        const alt = decodeHtmlEntities(el.getAttribute("alt") ?? "").trim();
        if (alt) emit(`![${alt}]`);
      },
    })
    .on("title", {
      text(chunk) {
        title += decodeHtmlEntities(chunk.text);
      },
    })
    .on("*", {
      text(chunk) {
        if (dropDepth > 0) return;
        if (maxChars !== undefined && length >= maxChars) return;

        if (preDepth > 0) {
          emit(decodeHtmlEntities(chunk.text));
          return;
        }

        // Collapse runs of whitespace, including the newlines that HTML
        // authors use purely for source formatting.
        const collapsed = decodeHtmlEntities(chunk.text).replace(/\s+/g, " ");
        if (collapsed.trim().length === 0) {
          // Preserve a single separating space, but never start a line or a
          // link label with one.
          const last = out[out.length - 1];
          if (collapsed === " " && last && !/[\s[]$/.test(last)) emit(" ");
          return;
        }
        emit(collapsed);
      },
    });

  await rewriter.transform(new Response(html)).text();

  // An unterminated `<a>` (truncated or malformed page) would otherwise leave
  // a dangling "[" that reads as broken Markdown.
  if (pendingLinkHref !== null) emit(`](${pendingLinkHref})`);

  const text = out
    .join("")
    // Three or more newlines is always an artifact of nested block tags.
    .replace(/\n{3,}/g, "\n\n")
    // Trailing spaces before a newline are invisible noise that still costs
    // tokens.
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  const truncated = maxChars !== undefined && text.length > maxChars;
  return {
    markdown: truncated ? text.slice(0, maxChars) : text,
    ...(title.trim() ? { title: title.trim().replace(/\s+/g, " ") } : {}),
    truncated,
  };
}
