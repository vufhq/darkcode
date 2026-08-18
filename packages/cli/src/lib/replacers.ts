/**
 * Fallback matching strategies for `editFile`.
 *
 * An exact-match edit tool fails constantly in practice, and almost never
 * because the model was wrong about *what* to change. It reproduces the code
 * from memory or from a paraphrased read, and gets the semantics right while
 * getting the whitespace wrong — a tab where the file has spaces, a block
 * re-indented after being quoted, a trailing space the model dropped. The edit
 * is correct; the byte comparison is not. Each of those is a wasted round trip,
 * and on a metered model a wasted round trip is money.
 *
 * The design borrowed from opencode: a strategy does not describe *how* to
 * transform the search text — it yields **candidate substrings that exist
 * verbatim in the file**. The caller then checks each candidate for uniqueness
 * and splices it. That inversion is what keeps the whole thing safe: however
 * fuzzy the matching gets, the text being replaced is always literal content
 * taken from the file, never something reconstructed. A strategy can be wrong
 * about *which* region the model meant, but it cannot corrupt the file with a
 * region that was never there.
 *
 * Order matters. Strategies run from strictest to loosest, so the least
 * surprising interpretation always wins, and looser rules only get consulted
 * once every stricter one has found nothing.
 */

/** Yields candidate substrings of `content` that may be what `search` meant. */
export type Replacer = {
  /** Reported back to the model when this strategy is what matched. */
  name: string;
  find: (content: string, search: string) => Generator<string>;
};

/** Character offset of the start of each line, for slicing by line range. */
function lineOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1; // +1 for the "\n" removed by split
  }
  return offsets;
}

/** The exact substring of `content` spanning lines `[start, end]` inclusive. */
function sliceLines(content: string, lines: string[], offsets: number[], start: number, end: number) {
  const from = offsets[start]!;
  const to = offsets[end]! + lines[end]!.length;
  return content.slice(from, to);
}

/**
 * Drop a trailing empty element produced by a search block that ends in a
 * newline, so `"a\nb\n"` compares as two lines rather than three.
 */
function searchLinesOf(search: string): string[] {
  const lines = search.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Exact match. Always first — if the model got the bytes right, nothing
 * cleverer should ever get a say.
 */
export const exactReplacer: Replacer = {
  name: "exact",
  *find(_content, search) {
    yield search;
  },
};

/**
 * The search text with surrounding whitespace trimmed.
 *
 * Catches the single most common near-miss: the model included a leading or
 * trailing newline that isn't in the file, or dropped one that is.
 */
export const trimmedReplacer: Replacer = {
  name: "trimmed",
  *find(content, search) {
    const trimmed = search.trim();
    if (trimmed !== "" && trimmed !== search && content.includes(trimmed)) yield trimmed;
  },
};

/**
 * Line-by-line comparison ignoring each line's leading and trailing whitespace.
 *
 * Handles trailing spaces, a tab-vs-spaces mismatch, and indentation that
 * drifted — while still requiring every line's *content* to match exactly, in
 * order. That makes it strict about what the code says and lenient only about
 * how it is laid out.
 */
export const lineTrimmedReplacer: Replacer = {
  name: "line-trimmed",
  *find(content, search) {
    const lines = content.split("\n");
    const offsets = lineOffsets(lines);
    const searchLines = searchLinesOf(search);
    if (searchLines.length === 0) return;

    for (let i = 0; i + searchLines.length <= lines.length; i++) {
      let matched = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (lines[i + j]!.trim() !== searchLines[j]!.trim()) {
          matched = false;
          break;
        }
      }
      if (matched) yield sliceLines(content, lines, offsets, i, i + searchLines.length - 1);
    }
  },
};

/** Strip the common leading indentation from every non-blank line. */
function dedent(text: string): string {
  const lines = text.split("\n");
  const meaningful = lines.filter((l) => l.trim().length > 0);
  if (meaningful.length === 0) return text;

  let min = Infinity;
  for (const line of meaningful) {
    const indent = line.length - line.trimStart().length;
    if (indent < min) min = indent;
  }
  if (!Number.isFinite(min) || min === 0) return text;

  return lines.map((l) => (l.trim().length === 0 ? l : l.slice(min))).join("\n");
}

/**
 * Compare blocks after removing their common indentation.
 *
 * The classic case: the model quotes a method body it read at four spaces of
 * indentation and reproduces it at zero, or vice versa. The *relative* shape
 * of the block is preserved, which is what distinguishes this from the
 * line-trimmed strategy — nesting inside the block still has to line up.
 */
export const indentationFlexibleReplacer: Replacer = {
  name: "indentation-flexible",
  *find(content, search) {
    const searchLines = searchLinesOf(search);
    if (searchLines.length === 0) return;

    const target = dedent(searchLines.join("\n"));
    const lines = content.split("\n");
    const offsets = lineOffsets(lines);

    for (let i = 0; i + searchLines.length <= lines.length; i++) {
      const block = sliceLines(content, lines, offsets, i, i + searchLines.length - 1);
      if (dedent(block) === target) yield block;
    }
  },
};

/** Collapse every run of whitespace to a single space, and trim. */
const collapseWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Compare with all whitespace runs collapsed.
 *
 * Looser than the two above — it no longer cares where the line breaks fall —
 * so it sits below them. Catches a block the model reflowed while quoting, or
 * a single line it rewrapped.
 */
export const whitespaceNormalizedReplacer: Replacer = {
  name: "whitespace-normalized",
  *find(content, search) {
    const target = collapseWhitespace(search);
    if (target === "") return;

    const lines = content.split("\n");
    const offsets = lineOffsets(lines);
    const searchLines = searchLinesOf(search);

    // Single-line searches: compare against each line on its own.
    if (searchLines.length === 1) {
      for (let i = 0; i < lines.length; i++) {
        if (collapseWhitespace(lines[i]!) === target) {
          yield sliceLines(content, lines, offsets, i, i);
        }
      }
      return;
    }

    // Multi-line: slide a window of the same line count.
    for (let i = 0; i + searchLines.length <= lines.length; i++) {
      const block = sliceLines(content, lines, offsets, i, i + searchLines.length - 1);
      if (collapseWhitespace(block) === target) yield block;
    }
  },
};

/** Levenshtein distance, with both inputs capped so this stays cheap. */
function levenshtein(a: string, b: string): number {
  const MAX = 200;
  if (a.length > MAX) a = a.slice(0, MAX);
  if (b.length > MAX) b = b.slice(0, MAX);
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two rolling rows rather than a full matrix — the algorithm only ever reads
  // the previous row, so keeping all of them wastes O(n·m) memory for nothing.
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/** Mean per-line similarity in [0,1] between two equal-ish line ranges. */
function blockSimilarity(a: string[], b: string[]): number {
  const count = Math.min(a.length, b.length);
  if (count === 0) return 1;

  let total = 0;
  for (let i = 0; i < count; i++) {
    const left = a[i]!.trim();
    const right = b[i]!.trim();
    const longest = Math.max(left.length, right.length);
    total += longest === 0 ? 1 : 1 - levenshtein(left, right) / longest;
  }
  return total / count;
}

/** How similar the interior of an anchored block must be to be accepted. */
const BLOCK_ANCHOR_SIMILARITY = 0.7;

/**
 * Anchor on the first and last lines of a multi-line block.
 *
 * The loosest strategy, and the one that rescues the hardest case: the model
 * quotes a function correctly at both ends but paraphrases something in the
 * middle. Anchors alone would be reckless, so a candidate must also be close
 * in size (within 25% of the expected line count) and its interior must reach
 * a similarity threshold — otherwise a file with several similarly-shaped
 * functions would happily match the wrong one.
 *
 * Requires at least three lines: with fewer, "first and last line" is nearly
 * the whole block and the anchors stop being evidence of anything.
 */
export const blockAnchorReplacer: Replacer = {
  name: "block-anchor",
  *find(content, search) {
    const searchLines = searchLinesOf(search);
    if (searchLines.length < 3) return;

    const lines = content.split("\n");
    const offsets = lineOffsets(lines);
    const firstAnchor = searchLines[0]!.trim();
    const lastAnchor = searchLines[searchLines.length - 1]!.trim();
    const expected = searchLines.length;
    const maxDelta = Math.max(1, Math.floor(expected * 0.25));

    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() !== firstAnchor) continue;

      for (let j = i + 2; j < lines.length; j++) {
        if (lines[j]!.trim() !== lastAnchor) continue;

        const size = j - i + 1;
        if (Math.abs(size - expected) <= maxDelta) {
          const interior = lines.slice(i + 1, j);
          const searchInterior = searchLines.slice(1, -1);
          if (blockSimilarity(interior, searchInterior) >= BLOCK_ANCHOR_SIMILARITY) {
            yield sliceLines(content, lines, offsets, i, j);
          }
        }
        // Only the nearest closing anchor is considered, so a long file of
        // similar blocks yields one candidate per opening rather than N².
        break;
      }
    }
  },
};

/**
 * Every strategy, strictest first.
 *
 * `exact` is handled separately by the caller so that an exact-but-ambiguous
 * match reports ambiguity rather than silently falling through to a fuzzier
 * rule — if the model's text appears three times verbatim, the answer is "be
 * more specific", not "let me guess".
 */
export const FALLBACK_REPLACERS: Replacer[] = [
  trimmedReplacer,
  // Before `line-trimmed`, because it is stricter: dedenting a block keeps the
  // nesting *inside* it intact, whereas trimming every line independently
  // throws that structure away. Ordered the other way round, the looser rule
  // would answer first and a genuinely reshaped block could match.
  indentationFlexibleReplacer,
  lineTrimmedReplacer,
  whitespaceNormalizedReplacer,
  blockAnchorReplacer,
];
