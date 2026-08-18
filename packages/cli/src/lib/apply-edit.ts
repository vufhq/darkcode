import { FALLBACK_REPLACERS } from "./replacers";
import {
  applyLineEnding,
  detectLineEnding,
  joinBom,
  normalizedIndexToRaw,
  normalizeNewlines,
  spliceRange,
  splitBom,
} from "./text";

/**
 * The pure core of the `editFile` tool: given a file's current contents and an
 * exact-match edit, produce the new contents.
 *
 * This is deliberately separated from `local-tools.ts`, which owns the
 * filesystem, the permission gate, and the LSP diagnostics loop. Splitting the
 * *decision* from the *effects* is what makes this testable: the whole matrix
 * of line endings, BOMs, and dollar-sign escapes can be exercised as plain
 * string-in/string-out assertions, with no temp directories, no permission
 * prompts, and no cleanup to get wrong. Anything that reads or writes the disk
 * is much harder to test thoroughly, so the less logic that lives on that side
 * of the line, the better.
 */

/** How many non-overlapping times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  // An empty needle matches at every position, which would make the scan below
  // loop forever. Callers reject it before we get here; this is a backstop.
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

export type ApplyEditResult = {
  /** The full new file contents, in the file's original line-ending convention. */
  content: string;
  /** Whether the file's dominant line ending is CRLF — useful for reporting. */
  crlf: boolean;
  /**
   * Which strategy matched. `"exact"` means the model's `oldString` was found
   * verbatim; anything else means a fallback rescued the edit, which is worth
   * reporting back so the model can see its quoting drifted.
   */
  strategy: string;
};

/**
 * Find the one region of `content` a fallback strategy believes `search` meant.
 *
 * A candidate is only usable if it occurs exactly once — a strategy that points
 * at three equally plausible regions has not disambiguated anything. Likewise a
 * strategy offering several *different* unique candidates is guessing, so it is
 * skipped rather than allowed to pick one.
 */
function findFallbackMatch(
  content: string,
  search: string,
): { match: string; strategy: string } | null {
  for (const replacer of FALLBACK_REPLACERS) {
    const usable = new Set<string>();

    for (const candidate of replacer.find(content, search)) {
      if (candidate === "") continue;
      if (countOccurrences(content, candidate) === 1) usable.add(candidate);
      // More than one distinct unique candidate means this strategy cannot
      // tell them apart; stop collecting and move on to the next one.
      if (usable.size > 1) break;
    }

    if (usable.size === 1) {
      return { match: [...usable][0]!, strategy: replacer.name };
    }
  }

  return null;
}

/**
 * Apply a single exact-match replacement.
 *
 * Throws when `oldString` is missing or ambiguous — the same two failure modes
 * (and the same messages) the tool has always reported, so the model's
 * recovery behavior is unchanged.
 */
export function applyEdit(raw: string, oldString: string, newString: string): ApplyEditResult {
  if (oldString === "") throw new Error("oldString must not be empty");

  // 1. Strip the BOM. It sits at index 0 and the model never emits one, so
  //    leaving it in place would break any edit anchored to the file's first
  //    line. It goes back on at the end.
  const { bom, body } = splitBom(raw);

  // 2. Remember the shape we have to hand back, before flattening it.
  const ending = detectLineEnding(body);

  // 3. Flatten both sides to the canonical form and match there. The file may
  //    be CRLF; the model's `oldString` almost never is. Comparing them
  //    directly is the bug — it fails on files that are perfectly editable,
  //    with an error ("oldString not found in file") that misdescribes the
  //    problem and sends the model off re-reading a file it already had right.
  const normalizedBody = normalizeNewlines(body);
  const normalizedOld = normalizeNewlines(oldString);
  const normalizedNew = normalizeNewlines(newString);

  // 4. Decide what text is actually being replaced.
  //
  //    An exact hit wins outright. An exact hit that occurs more than once is
  //    reported as ambiguous rather than handed to a fuzzier strategy: if the
  //    model's text appears three times verbatim, the useful answer is "quote
  //    more context", not a guess. Only a *miss* opens the fallback chain.
  const occurrences = countOccurrences(normalizedBody, normalizedOld);
  if (occurrences > 1) throw new Error(`oldString is ambiguous; found ${occurrences} matches`);

  let matchText = normalizedOld;
  let strategy = "exact";

  if (occurrences === 0) {
    const fallback = findFallbackMatch(normalizedBody, normalizedOld);
    if (!fallback) throw new Error("oldString not found in file");
    matchText = fallback.match;
    strategy = fallback.strategy;
  }

  // 5. Locate the match in canonical space, then translate those offsets back
  //    into the raw string so the splice lands on the original bytes. Editing
  //    the normalized copy and converting the whole file back would rewrite
  //    every line ending in a mixed-ending file — a two-line change arriving
  //    as a whole-file diff.
  const normalizedStart = normalizedBody.indexOf(matchText);
  const normalizedEnd = normalizedStart + matchText.length;
  const rawStart = normalizedIndexToRaw(body, normalizedStart);
  const rawEnd = normalizedIndexToRaw(body, normalizedEnd);

  // 6. Give the replacement the file's own line-ending convention, so inserted
  //    lines match the ones around them instead of seeding a mixed file.
  const rawNew = applyLineEnding(normalizedNew, ending);

  // 7. Splice by index. Never `String.replace` — see the note on `spliceRange`
  //    for why a `$` in the replacement would otherwise corrupt the write.
  const nextBody = spliceRange(body, rawStart, rawEnd, rawNew);

  return { content: joinBom(nextBody, bom), crlf: ending === "\r\n", strategy };
}
