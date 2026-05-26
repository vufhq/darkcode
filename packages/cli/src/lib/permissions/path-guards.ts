import type { DecisionOutcome, FsRules } from "./types";

// Minimal glob-to-regex compiler. Supports:
//   `**`  zero or more path segments (including the separator)
//   `*`   any character except `/`
//   `?`   any single character except `/`
//
// The path is normalized to forward slashes before matching so Windows
// project-relative paths classify the same as POSIX ones.
export function globToRegex(pattern: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // Consume `**` and an optional trailing `/`.
        out += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        out += "[^/]*";
        i++;
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += "\\" + ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  out += "$";
  return new RegExp(out);
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function firstMatch(path: string, patterns: string[]): string | null {
  const normalized = normalize(path);
  for (const pattern of patterns) {
    if (globToRegex(pattern).test(normalized)) return pattern;
  }
  return null;
}

// Classify a write (or edit) against the fs policy. `projectRelativePath` is
// expected to have already passed the resolveInsideCwd check upstream.
export function classifyFsWrite(projectRelativePath: string, rules: FsRules): DecisionOutcome {
  const denied = firstMatch(projectRelativePath, rules.denyWrite);
  if (denied) {
    return {
      decision: "deny",
      reason: `Path "${projectRelativePath}" matches deny rule`,
      matchedRule: denied,
    };
  }

  const allowed = firstMatch(projectRelativePath, rules.allowWrite);
  if (allowed) {
    return {
      decision: "allow",
      reason: `Path "${projectRelativePath}" matches allow rule`,
      matchedRule: allowed,
    };
  }

  return {
    decision: "ask",
    reason: `Path "${projectRelativePath}" not covered by any rule`,
    matchedRule: "",
  };
}
