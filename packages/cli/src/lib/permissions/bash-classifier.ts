import { classifyFsWrite, escapesProject } from "./path-guards";
import type { BashRules, DecisionOutcome, FsRules } from "./types";

// Tokenize a shell command into pipeline segments. Splits on `|`, `&&`, `||`,
// `;`, `&`, and newlines, and recurses into `$(...)` and backtick
// substitutions so a hidden destructive command can't slip through inside a
// substitution.
//
// Newlines and the single `&` are separators in their own right: `bash -c`
// happily runs a multi-line string, and `a & b` backgrounds `a` then runs `b`.
// Missing either one used to collapse two commands into a single segment whose
// leading tokens matched an allow rule with a trailing `**` — which swallowed
// the rest of the line and bypassed the deny list outright
// (`git status\nrm -rf /` classified as ALLOW).
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
    // A lone `&` backgrounds the preceding command and starts a new one, so it
    // separates just like `;`. Checked after `&&` above so the doubled form
    // still consumes both characters.
    if (ch === "|" || ch === ";" || ch === "&") {
      flush();
      i++;
      continue;
    }
    // Newlines separate commands in a multi-line script.
    if (ch === "\n" || ch === "\r") {
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

// ---------------------------------------------------------------------------
// Redirections
// ---------------------------------------------------------------------------

// A redirection operator, optionally prefixed by a file descriptor (`2>`) or
// `&` (`&>`), optionally suffixed by `|` (`>|`, the noclobber override).
// Written to match either a standalone token (`>`) or one with the target
// attached (`>out.txt`), which is equally valid shell.
const REDIRECT_TOKEN = /^(?:&|\d*)(>>?|<<<|<<|<)\|?(.*)$/;

export type Redirect = {
  /** The operator as written, e.g. `>`, `>>`, `2>`, `&>`. */
  op: string;
  /** The redirect target as written. Empty when it followed as a separate token and none was present. */
  target: string;
  /** True for output redirections — the ones that create or truncate a file. */
  writes: boolean;
};

export type SegmentParse = {
  /** Tokens with the redirection operators and their targets removed. */
  commandTokens: string[];
  redirects: Redirect[];
};

// Split a segment's tokens into "the command" and "the redirections it
// performs". Redirect tokens are pulled out of the command token list so a
// pattern like `echo **` classifies the *command* `echo hi` rather than
// silently absorbing `> ~/.ssh/authorized_keys` into its trailing `**`.
export function parseSegment(tokens: string[]): SegmentParse {
  const commandTokens: string[] = [];
  const redirects: Redirect[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const match = REDIRECT_TOKEN.exec(token);
    // A bare `<` or `>` inside a quoted token was already stripped of its
    // quotes by `tokenize`, so we can't distinguish it — that's acceptable:
    // treating a quoted `">"` as a redirect only costs an extra prompt.
    if (!match) {
      commandTokens.push(token);
      continue;
    }

    const op = token.slice(0, token.length - match[2]!.length);
    const writes = match[1]!.startsWith(">");
    // Heredocs (`<<EOF`) name a delimiter, not a file — never a filesystem target.
    const isHeredoc = match[1] === "<<" || match[1] === "<<<";

    let target = match[2]!;
    if (target.length === 0 && i + 1 < tokens.length) {
      // Operator and target were separate tokens: `> out.txt`.
      target = tokens[i + 1]!;
      i++;
    }

    redirects.push({ op, target, writes: writes && !isHeredoc });
  }

  return { commandTokens, redirects };
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
//   - Else if a write redirection targets a denied path -> deny.
//   - Else if every segment matches `allow` and none redirects -> allow.
//   - Else if any segment matches `ask` -> ask.
//   - Else (some segment is unmatched, or a write redirection is present) -> ask.
//
// "Every segment must be allowed" is the safe rule: it prevents a chained
// `git status | rm -rf /` from being green-lit by the leading allowed
// command.
//
// `fsRules` is optional only so the pure-classifier tests can call this
// without a policy; the engine always passes it. Without it, any write
// redirection conservatively forces a prompt.
export function classifyBash(
  command: string,
  rules: BashRules,
  fsRules?: FsRules,
): DecisionOutcome {
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
  // Set when a segment writes to a file via `>`/`>>`. Shell redirection
  // bypasses the writeFile/editFile tools entirely, so it has to be judged
  // against the same fs policy rather than riding on the command's allow rule.
  let redirectAskReason: string | null = null;

  for (const segment of segments) {
    const rawTokens = tokenize(segment);
    if (rawTokens.length === 0) {
      // A segment that tokenizes to nothing (e.g., unbalanced quotes) is
      // suspicious — treat as unmatched.
      allAllowed = false;
      unmatchedSegment = segment;
      continue;
    }

    const { commandTokens, redirects } = parseSegment(rawTokens);

    for (const redirect of redirects) {
      if (!redirect.writes) continue;

      // A target we can't resolve lexically (empty, or carrying an unexpanded
      // `$VAR` / substitution) never auto-allows — it goes to the user.
      if (redirect.target.length === 0 || /[$`]/.test(redirect.target)) {
        redirectAskReason ??= `Command writes to an unresolved redirect target "${redirect.op} ${redirect.target}"`;
        allAllowed = false;
        continue;
      }

      if (escapesProject(redirect.target)) {
        return {
          decision: "deny",
          reason: `Redirect "${redirect.op} ${redirect.target}" writes outside the project directory`,
          matchedRule: "",
        };
      }

      if (fsRules) {
        const outcome = classifyFsWrite(redirect.target, fsRules);
        if (outcome.decision === "deny") {
          return {
            decision: "deny",
            reason: `Redirect "${redirect.op} ${redirect.target}" ${outcome.reason}`,
            matchedRule: outcome.matchedRule,
          };
        }
      }

      // In-project and not denied — still prompt. An allow rule covers a
      // command, never the arbitrary file that command's output is aimed at.
      redirectAskReason ??= `Command writes to "${redirect.target}" via "${redirect.op}"`;
      allAllowed = false;
    }

    const tokens = commandTokens.length > 0 ? commandTokens : rawTokens;

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

  // A write redirection is reported ahead of a generic ask rule: it's the more
  // specific and more consequential fact about the command.
  if (redirectAskReason) {
    return {
      decision: "ask",
      reason: redirectAskReason,
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
