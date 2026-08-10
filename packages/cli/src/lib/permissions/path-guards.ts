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

// Does this path, read literally, point outside the project directory?
//
// Purely lexical — it's used on shell redirect targets, which never reach
// `resolveInsideCwd` and so have no resolved form to check. Absolute paths,
// `~` expansions, Windows drive/UNC roots, and any `..` that climbs above the
// project root all count as escaping.
export function escapesProject(path: string): boolean {
  const normalized = normalize(path.trim());
  if (normalized.length === 0) return false;

  if (normalized.startsWith("/")) return true;
  if (normalized === "~" || normalized.startsWith("~/")) return true;
  // `C:/…` or `//server/share`.
  if (/^[a-zA-Z]:/.test(normalized)) return true;

  let depth = 0;
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      depth--;
      if (depth < 0) return true;
      continue;
    }
    depth++;
  }
  return false;
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

// Classify a read against the fs policy. Reads are allow-by-default — a coding
// agent that has to ask before every file read is unusable — but the secret
// globs in `denyRead` are refused outright rather than prompted. A prompt is
// the wrong control here: it arrives mid-task with no context, and the user
// who's been clicking "allow" for the last ten reads clicks it again. Anything
// matching is content we never want reaching the model or the server.
export function classifyFsRead(projectRelativePath: string, rules: FsRules): DecisionOutcome {
  const denied = firstMatch(projectRelativePath, rules.denyRead);
  if (denied) {
    return {
      decision: "deny",
      reason: `Path "${projectRelativePath}" matches a protected-file rule; its contents are never sent to the model`,
      matchedRule: denied,
    };
  }

  return {
    decision: "allow",
    reason: `Path "${projectRelativePath}" is not a protected file`,
    matchedRule: "",
  };
}
