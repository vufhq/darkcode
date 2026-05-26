import type { BashRules, DecisionOutcome } from "./types";

// Tokenize a shell command into pipeline segments. Splits on `|`, `&&`, `||`,
// `;`, and recurses into `$(...)` and backtick substitutions so a hidden
// destructive command can't slip through inside a substitution.
//
// This is intentionally not a full POSIX shell parser — it understands
// enough to classify the operations a model is likely to attempt, and to
// default-deny anything that doesn't parse cleanly.
export function splitIntoSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed.length > 0) segments.push(trimmed);
    buf = "";
  };

  while (i < command.length) {
    const ch = command[i]!;

    if (inSingle) {
      buf += ch;
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      buf += ch;
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      buf += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      buf += ch;
      i++;
      continue;
    }

    // Command substitution: recurse, then drop the substitution from the
    // outer segment (we classify it separately).
    if (ch === "$" && command[i + 1] === "(") {
      const end = findMatching(command, i + 1, "(", ")");
      if (end === -1) {
        // Unbalanced — bail out, return a single segment that will fail
        // matching and route to ask/deny.
        return [command.trim()];
      }
      const inner = command.slice(i + 2, end);
      const innerSegments = splitIntoSegments(inner);
      segments.push(...innerSegments);
      i = end + 1;
      continue;
    }
    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      if (end === -1) return [command.trim()];
      const inner = command.slice(i + 1, end);
      const innerSegments = splitIntoSegments(inner);
      segments.push(...innerSegments);
      i = end + 1;
      continue;
    }

    // Pipeline / sequence operators.
    if (ch === "|" && command[i + 1] === "|") {
      flush();
      i += 2;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      flush();
      i += 2;
      continue;
    }
    if (ch === "|" || ch === ";") {
      flush();
      i++;
      continue;
    }

    buf += ch;
    i++;
  }

  if (inSingle || inDouble) {
    // Unbalanced quotes — return the whole thing as one segment so it falls
    // through to ask/deny.
    return [command.trim()];
  }

  flush();
  return segments;
}

function findMatching(s: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Tokenize a segment into whitespace-separated tokens, preserving quoted
// strings as a single token (with the quotes stripped).
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;

  const flush = () => {
    if (buf.length > 0) {
      tokens.push(buf);
      buf = "";
    }
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else buf += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else buf += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      flush();
      continue;
    }
    buf += ch;
  }

  flush();
  return tokens;
}

// Match a tokenized segment against a glob-style pattern.
//
// Pattern tokens:
//   - `**`  matches zero or more remaining segment tokens (only valid as the
//           last pattern token; used for "command with any args")
//   - `*`   matches exactly one segment token
//   - any other pattern token matches that token literally
//
// Both the pattern and the segment are tokenized the same way.
export function matchesPattern(segmentTokens: string[], pattern: string): boolean {
  const patternTokens = tokenize(pattern);
  let pi = 0;
  let si = 0;

  while (pi < patternTokens.length) {
    const pt = patternTokens[pi]!;
    if (pt === "**") {
      // Greedy rest-match. Only meaningful as the final pattern token.
      return pi === patternTokens.length - 1;
    }
    if (si >= segmentTokens.length) return false;
    if (pt !== "*" && pt !== segmentTokens[si]) return false;
    pi++;
    si++;
  }
  return si === segmentTokens.length;
}

function firstMatch(segmentTokens: string[], patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (matchesPattern(segmentTokens, pattern)) return pattern;
  }
  return null;
}

// Classify an entire bash command line.
//
// Rules:
//   - If any segment matches `deny` -> deny (whole command).
//   - Else if every segment matches `allow` -> allow.
//   - Else if any segment matches `ask` -> ask.
//   - Else (some segment is unmatched) -> ask.
//
// "Every segment must be allowed" is the safe rule: it prevents a chained
// `git status | rm -rf /` from being green-lit by the leading allowed
// command.
export function classifyBash(command: string, rules: BashRules): DecisionOutcome {
  const segments = splitIntoSegments(command);

  if (segments.length === 0) {
    return {
      decision: "deny",
      reason: "Empty command",
      matchedRule: "",
    };
  }

  let firstAskRule: string | null = null;
  let allAllowed = true;
  let unmatchedSegment: string | null = null;

  for (const segment of segments) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) {
      // A segment that tokenizes to nothing (e.g., unbalanced quotes) is
      // suspicious — treat as unmatched.
      allAllowed = false;
      unmatchedSegment = segment;
      continue;
    }

    const denied = firstMatch(tokens, rules.deny);
    if (denied) {
      return {
        decision: "deny",
        reason: `Segment "${segment}" matches deny rule`,
        matchedRule: denied,
      };
    }

    const allowed = firstMatch(tokens, rules.allow);
    if (allowed) continue;

    allAllowed = false;
    const asked = firstMatch(tokens, rules.ask);
    if (asked && !firstAskRule) firstAskRule = asked;
    if (!asked && !unmatchedSegment) unmatchedSegment = segment;
  }

  if (allAllowed) {
    return {
      decision: "allow",
      reason: "All segments matched allow rules",
      matchedRule: "",
    };
  }

  if (firstAskRule) {
    return {
      decision: "ask",
      reason: `Segment matches ask rule`,
      matchedRule: firstAskRule,
    };
  }

  return {
    decision: "ask",
    reason: unmatchedSegment
      ? `Segment "${unmatchedSegment}" is not in any policy list`
      : "Command has no matching policy",
    matchedRule: "",
  };
}
