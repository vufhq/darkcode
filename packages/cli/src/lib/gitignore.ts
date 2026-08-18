/**
 * A focused implementation of gitignore pattern matching.
 *
 * The file tools walk the user's project, and a project's `.gitignore` is the
 * best available statement of which files are *source* and which are build
 * output, dependencies, or noise. Ignoring it means `grep` spends its scan
 * budget on `dist/`, `build/`, coverage reports and lockfiles, and reports
 * matches from generated code that the user cannot act on.
 *
 * Gitignore syntax looks like globbing but is not: patterns anchor differently
 * depending on whether they contain a slash, `!` re-includes, a trailing slash
 * restricts a rule to directories, and precedence runs last-match-wins across
 * nested files. Approximating it with substring checks gets the common cases
 * wrong in both directions, so the rules are parsed properly here.
 *
 * Deliberately not supported: `.git/info/exclude`, the global
 * `core.excludesFile`, and `.gitattributes`. Those live outside the project
 * tree and are not part of what a repository states about itself.
 */

/** One parsed `.gitignore` line. */
export type IgnoreRule = {
  /** A `!` rule, which re-includes a path an earlier rule excluded. */
  negated: boolean;
  /** A trailing-slash rule, which only ever matches directories. */
  dirOnly: boolean;
  /** Matched against a path relative to the rule's own `.gitignore` directory. */
  regex: RegExp;
  /** The original line, kept for debugging and test readability. */
  source: string;
};

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const escapeLiteral = (char: string) => char.replace(REGEX_META, "\\$&");

/**
 * Translate one path segment of a gitignore pattern into regex source.
 *
 * The key difference from ordinary regex: `*` and `?` must not cross a path
 * separator, so they compile to `[^/]` forms rather than `.`.
 */
function segmentToRegex(segment: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!;

    if (char === "*") {
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }

    // Character class: `[abc]`, `[!abc]`, `[a-z]`. Git uses `!` for negation
    // where regex uses `^`.
    if (char === "[") {
      let end = i + 1;
      if (segment[end] === "!" || segment[end] === "^") end++;
      // A `]` immediately after the opening bracket is a literal member.
      if (segment[end] === "]") end++;
      while (end < segment.length && segment[end] !== "]") end++;

      if (end >= segment.length) {
        // Unterminated class — git treats the bracket as a literal.
        out += "\\[";
        continue;
      }

      let body = segment.slice(i + 1, end);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      out += `[${body}]`;
      i = end;
      continue;
    }

    // Backslash escapes the next character, making it literal.
    if (char === "\\") {
      const next = segment[i + 1];
      if (next === undefined) {
        out += "\\\\";
        continue;
      }
      out += escapeLiteral(next);
      i++;
      continue;
    }

    out += escapeLiteral(char);
  }
  return out;
}

/**
 * Compile a full gitignore pattern (already stripped of `!` and trailing `/`)
 * into an anchored regex.
 *
 * `anchored` reflects gitignore's most surprising rule: a pattern containing a
 * slash anywhere is relative to the `.gitignore`'s own directory, while a
 * pattern with no slash matches at *any* depth below it. So `build/` ignores
 * every `build` directory in the subtree, but `src/build/` ignores exactly one.
 */
function patternToRegex(pattern: string, anchored: boolean): RegExp {
  const segments = pattern.split("/");
  let source = "";
  let needsSeparator = false;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const isLast = i === segments.length - 1;

    if (segment === "**") {
      if (isLast) {
        // A trailing `/**` matches everything *inside*, but not the directory
        // itself.
        source += needsSeparator ? "/.*" : ".*";
      } else {
        // `**/` in a leading or interior position spans zero or more
        // directories, so `a/**/b` must still match `a/b`.
        source += needsSeparator ? "/(?:.*/)?" : "(?:.*/)?";
      }
      needsSeparator = false;
      continue;
    }

    if (needsSeparator) source += "/";
    source += segmentToRegex(segment);
    needsSeparator = true;
  }

  // An unanchored pattern may begin at any directory depth.
  const prefix = anchored ? "" : "(?:.*/)?";
  return new RegExp(`^${prefix}${source}$`);
}

/**
 * Strip unescaped trailing whitespace, which git ignores unless it is escaped.
 */
function trimTrailingWhitespace(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) {
    // A backslash immediately before the run makes the whitespace significant.
    let backslashes = 0;
    let i = end - 2;
    while (i >= 0 && line[i] === "\\") {
      backslashes++;
      i--;
    }
    if (backslashes % 2 === 1) break;
    end--;
  }
  return line.slice(0, end);
}

/** Parse the contents of a single `.gitignore` file into ordered rules. */
export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];

  for (const rawLine of content.split(/\r\n|\n/)) {
    const source = rawLine;
    let line = trimTrailingWhitespace(rawLine);

    // Blank lines carry no rule. `#` starts a comment; `\#` is a literal `#`.
    if (line === "") continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("\\#")) line = line.slice(1);

    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!")) {
      line = line.slice(1);
    }

    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }

    if (line === "") continue;

    // A slash anywhere (now that any trailing one is gone) anchors the pattern
    // to the .gitignore's directory. A leading slash anchors without itself
    // being part of the path.
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (line === "") continue;

    // A trailing `/**` also matches the base directory itself, not just its
    // contents — `git check-ignore tmp/` matches the rule `tmp/**`, while a
    // *file* named `tmp` does not. Modelling that as a second, directory-only
    // rule for the base reproduces git exactly and keeps each regex simple.
    // It also lets a walker prune the directory outright, which is the whole
    // point of knowing it is ignored.
    if (line.endsWith("/**")) {
      const base = line.slice(0, -3);
      if (base !== "") {
        rules.push({ negated, dirOnly: true, regex: patternToRegex(base, anchored), source });
      }
    }

    rules.push({ negated, dirOnly, regex: patternToRegex(line, anchored), source });
  }

  return rules;
}

/** Rules from one `.gitignore`, plus the directory it governs. */
type Layer = { base: string; rules: IgnoreRule[] };

/**
 * Accumulates `.gitignore` files as a directory walk descends, and answers
 * whether a given path is ignored.
 *
 * Layers are consulted in insertion order and the *last* match wins, which
 * gives the two precedence rules git specifies at once: later lines beat
 * earlier lines within a file, and a nested `.gitignore` beats its parent —
 * provided layers are added shallowest-first, which is the natural order for a
 * top-down walk.
 */
export class GitignoreMatcher {
  private layers: Layer[] = [];

  /**
   * Register a `.gitignore`. `base` is its directory, relative to the walk
   * root, with `""` meaning the root itself.
   */
  add(base: string, content: string): void {
    const rules = parseGitignore(content);
    if (rules.length > 0) this.layers.push({ base, rules });
  }

  /** True when no `.gitignore` has contributed any rule. */
  get isEmpty(): boolean {
    return this.layers.length === 0;
  }

  /**
   * Evaluate every layer against one path and return the final verdict, or
   * `undefined` when no rule matched at all.
   */
  private verdict(relPath: string, isDir: boolean): boolean | undefined {
    let ignored: boolean | undefined;

    for (const layer of this.layers) {
      // A layer only governs its own subtree.
      let scoped: string;
      if (layer.base === "") {
        scoped = relPath;
      } else if (relPath.startsWith(`${layer.base}/`)) {
        scoped = relPath.slice(layer.base.length + 1);
      } else {
        continue;
      }

      for (const rule of layer.rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.regex.test(scoped)) ignored = !rule.negated;
      }
    }

    return ignored;
  }

  /**
   * Whether `relPath` (POSIX-separated, relative to the walk root) is ignored.
   *
   * Ancestors are checked first because git cannot re-include a file whose
   * parent directory is excluded — once a directory is out, everything beneath
   * it is out, and no `!` rule inside can bring it back. That is also what
   * makes it safe for a walker to prune an ignored directory instead of
   * descending into it.
   */
  isIgnored(relPath: string, isDir: boolean): boolean {
    const segments = relPath.split("/");

    for (let i = 0; i < segments.length - 1; i++) {
      const ancestor = segments.slice(0, i + 1).join("/");
      if (this.verdict(ancestor, true) === true) return true;
    }

    return this.verdict(relPath, isDir) === true;
  }
}
