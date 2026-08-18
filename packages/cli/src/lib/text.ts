/**
 * Text-shape primitives shared by the file tools.
 *
 * Every tool that moves text between the user's disk and the model crosses a
 * boundary between two different conventions:
 *
 *   - On disk, a file has *a* line-ending convention (LF on Unix, CRLF on
 *     Windows) and may carry a byte-order mark. That shape is the user's, and
 *     we do not get to change it.
 *   - In the conversation, the model overwhelmingly emits `\n` and never emits
 *     a BOM, regardless of what it was shown.
 *
 * Matching raw disk bytes against model-authored text therefore fails for
 * reasons that have nothing to do with the edit being wrong. The fix is the
 * standard one for any system with two representations of the same value:
 * normalize to a single canonical form at the boundary, do all the work in
 * that form, and convert back on the way out.
 */

/** The two line-ending conventions we round-trip. */
export type LineEnding = "\n" | "\r\n";

/** A UTF-8 byte-order mark, decoded. */
const BOM = "﻿";

/**
 * Split a leading BOM off the text.
 *
 * Node decodes the UTF-8 BOM to U+FEFF rather than stripping it, and re-encodes
 * it on write — so it round-trips on its own. It still has to come off for
 * *matching*, because it sits at index 0 and the model never includes it. An
 * edit whose `oldString` starts at the very top of the file would otherwise
 * never match.
 */
export function splitBom(text: string): { bom: boolean; body: string } {
  return text.startsWith(BOM) ? { bom: true, body: text.slice(1) } : { bom: false, body: text };
}

/** Re-attach a BOM that `splitBom` removed. */
export function joinBom(text: string, bom: boolean): string {
  return bom ? BOM + text : text;
}

/**
 * Convert CRLF to LF. This is the canonical form all matching happens in.
 *
 * Deliberately narrow: only `\r\n` is rewritten. A lone `\r` is left exactly
 * as it is. Classic Mac OS used bare `\r` as a line terminator, but that
 * convention is dead, and a lone `\r` in a file today is far more likely to be
 * *data* — a progress-bar redraw in a captured log, a fixture asserting on
 * carriage returns. Rewriting it would corrupt the file to fix a problem
 * nobody has.
 */
export function normalizeNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

/** Convert LF-canonical text to the given convention. */
export function applyLineEnding(text: string, ending: LineEnding): string {
  return ending === "\n" ? normalizeNewlines(text) : normalizeNewlines(text).replaceAll("\n", "\r\n");
}

/**
 * Pick the line ending a file predominantly uses.
 *
 * Counting rather than "does it contain a CRLF anywhere" matters for mixed
 * files, which are common in repositories shared between platforms. A single
 * stray CRLF in an otherwise-LF file should not cause a newly inserted line to
 * arrive as CRLF. Ties go to LF.
 */
export function detectLineEnding(text: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    if (i > 0 && text[i - 1] === "\r") crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Split text into lines on any line-ending convention.
 *
 * `text.split("\n")` is the tempting one-liner and it is wrong for CRLF input:
 * every resulting line keeps a trailing `\r`. That invisible character then
 * breaks `$`-anchored regexes, corrupts equality checks, and travels into the
 * model's context as a stray control character.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n/);
}

/**
 * Map an index in the LF-normalized form of `raw` back to its index in `raw`.
 *
 * Normalization only ever *deletes* characters — the `\r` of each `\r\n` pair —
 * so the mapping is monotonically increasing and computable in a single pass
 * with no auxiliary table. We walk the raw string, advancing a "normalized
 * position" counter for every character that survives normalization, and stop
 * when that counter reaches the target.
 *
 * This is what lets an edit be *surgical*: we locate the match in canonical
 * space but splice into the original bytes, so every line the model did not
 * touch stays byte-for-byte identical. The naive alternative — normalize the
 * whole file, edit, and convert the whole thing back — silently rewrites the
 * line endings of a mixed-ending file from top to bottom, turning a two-line
 * change into a whole-file diff.
 */
export function normalizedIndexToRaw(raw: string, normalizedIndex: number): number {
  let normalized = 0;
  let i = 0;
  while (i < raw.length) {
    if (normalized === normalizedIndex) return i;
    // A `\r` that is immediately followed by `\n` vanishes under
    // normalization, so it consumes a raw character without advancing the
    // normalized counter.
    if (raw[i] === "\r" && raw[i + 1] === "\n") {
      i++;
      continue;
    }
    i++;
    normalized++;
  }
  // The index sits at (or past) the very end of the string.
  return raw.length;
}

/**
 * Replace the half-open range `[start, end)` of `text` with `replacement`,
 * treating `replacement` as literal data.
 *
 * This exists because `String.prototype.replace` does not. Even when the
 * pattern is a plain string rather than a regex, `replace` scans the
 * *replacement* for substitution patterns:
 *
 *   `$$`  an escaped literal `$`      →  emits one `$`
 *   `$&`  the matched substring       →  re-emits what we were replacing
 *   `` $` ``  everything before the match  →  duplicates the file prefix
 *   `$'`  everything after the match   →  duplicates the file suffix
 *
 * So `"cost $$5".replace("OLD", newString)` will quietly mangle any
 * replacement containing those two-character sequences — and `$$` alone shows
 * up in shell scripts, Makefiles, PHP, jQuery, CSS-in-JS, and any dollar
 * amount written twice. The write succeeds and reports success; only the bytes
 * are wrong.
 *
 * The general lesson is worth more than the specific fix: this is an *in-band
 * signaling* bug. `replace` uses characters that can legitimately appear in
 * data (`$`) to carry control meaning, so data that happens to contain them is
 * reinterpreted as instructions. SQL injection, shell injection, format-string
 * bugs, and CSV files containing commas are all the same bug wearing different
 * clothes. The reliable defense is never to hand data to an interpreter that
 * might read it as control — here, by splicing with `slice`, which has no
 * interpretation step at all.
 */
export function spliceRange(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}
