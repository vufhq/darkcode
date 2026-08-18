import { describe, expect, test } from "bun:test";

import { GitignoreMatcher, parseGitignore } from "./gitignore";

/** Build a matcher from a single root-level .gitignore. */
function root(content: string) {
  const m = new GitignoreMatcher();
  m.add("", content);
  return m;
}

describe("parseGitignore — line handling", () => {
  test("skips blank lines and comments", () => {
    expect(parseGitignore("\n# a comment\n\n   \n")).toHaveLength(0);
  });

  test("`\\#` is a literal hash, not a comment", () => {
    const rules = parseGitignore("\\#notacomment");
    expect(rules).toHaveLength(1);
    expect(root("\\#notacomment").isIgnored("#notacomment", false)).toBe(true);
  });

  test("trailing whitespace is stripped", () => {
    expect(root("build   ").isIgnored("build", true)).toBe(true);
  });

  test("escaped trailing whitespace is significant", () => {
    // `foo\ ` means a file literally named "foo ".
    const m = root("foo\\ ");
    expect(m.isIgnored("foo ", false)).toBe(true);
    expect(m.isIgnored("foo", false)).toBe(false);
  });

  test("records the source line for each rule", () => {
    expect(parseGitignore("dist/")[0]!.source).toBe("dist/");
  });

  test("parses CRLF files", () => {
    expect(parseGitignore("a\r\nb\r\n")).toHaveLength(2);
  });
});

describe("anchoring — the rule people get wrong", () => {
  test("a pattern with no slash matches at every depth", () => {
    const m = root("build");
    expect(m.isIgnored("build", true)).toBe(true);
    expect(m.isIgnored("src/build", true)).toBe(true);
    expect(m.isIgnored("a/b/c/build", true)).toBe(true);
  });

  test("a pattern containing a slash is anchored to the .gitignore's directory", () => {
    const m = root("src/build");
    expect(m.isIgnored("src/build", true)).toBe(true);
    // Anchored, so a deeper `src/build` does not match.
    expect(m.isIgnored("a/src/build", true)).toBe(false);
  });

  test("a leading slash anchors without becoming part of the path", () => {
    const m = root("/build");
    expect(m.isIgnored("build", true)).toBe(true);
    expect(m.isIgnored("src/build", true)).toBe(false);
  });

  test("a trailing slash restricts the rule to directories", () => {
    const m = root("build/");
    expect(m.isIgnored("build", true)).toBe(true);
    // A *file* named build is not ignored by `build/`.
    expect(m.isIgnored("build", false)).toBe(false);
  });

  test("without a trailing slash both files and directories match", () => {
    const m = root("build");
    expect(m.isIgnored("build", true)).toBe(true);
    expect(m.isIgnored("build", false)).toBe(true);
  });
});

describe("wildcards", () => {
  test("`*` does not cross a path separator", () => {
    const m = root("*.log");
    expect(m.isIgnored("a.log", false)).toBe(true);
    expect(m.isIgnored("deep/a.log", false)).toBe(true);
    expect(m.isIgnored("a.log.txt", false)).toBe(false);
  });

  test("an anchored `*` stays within one segment", () => {
    const m = root("src/*.ts");
    expect(m.isIgnored("src/a.ts", false)).toBe(true);
    expect(m.isIgnored("src/nested/a.ts", false)).toBe(false);
  });

  test("`?` matches exactly one non-separator character", () => {
    const m = root("file?.ts");
    expect(m.isIgnored("file1.ts", false)).toBe(true);
    expect(m.isIgnored("file.ts", false)).toBe(false);
    expect(m.isIgnored("file12.ts", false)).toBe(false);
  });

  test("a leading `**/` spans zero or more directories", () => {
    const m = root("**/logs");
    expect(m.isIgnored("logs", true)).toBe(true);
    expect(m.isIgnored("a/logs", true)).toBe(true);
    expect(m.isIgnored("a/b/logs", true)).toBe(true);
  });

  test("a trailing `/**` matches everything inside, and the directory itself", () => {
    // Verified against `git check-ignore -v`: the rule `logs/**` matches the
    // probe `logs/`, but not a plain file named `logs`.
    const m = root("logs/**");
    expect(m.isIgnored("logs/a.txt", false)).toBe(true);
    expect(m.isIgnored("logs/deep/a.txt", false)).toBe(true);
    expect(m.isIgnored("logs", true)).toBe(true);
    expect(m.isIgnored("logs", false)).toBe(false);
  });

  test("an interior `/**/` spans zero or more directories", () => {
    const m = root("a/**/b");
    expect(m.isIgnored("a/b", false)).toBe(true);
    expect(m.isIgnored("a/x/b", false)).toBe(true);
    expect(m.isIgnored("a/x/y/b", false)).toBe(true);
    expect(m.isIgnored("x/a/b", false)).toBe(false);
  });

  test("character classes work, including negation", () => {
    expect(root("file[0-9].ts").isIgnored("file7.ts", false)).toBe(true);
    expect(root("file[0-9].ts").isIgnored("filex.ts", false)).toBe(false);
    expect(root("file[!0-9].ts").isIgnored("filex.ts", false)).toBe(true);
    expect(root("file[!0-9].ts").isIgnored("file7.ts", false)).toBe(false);
  });

  test("regex metacharacters in a pattern are literal", () => {
    const m = root("a.b+c");
    expect(m.isIgnored("a.b+c", false)).toBe(true);
    // `.` and `+` must not act as regex operators.
    expect(m.isIgnored("axbbc", false)).toBe(false);
  });

  test("patterns are anchored at both ends", () => {
    const m = root("build");
    expect(m.isIgnored("rebuild", true)).toBe(false);
    expect(m.isIgnored("builds", true)).toBe(false);
  });
});

describe("negation and precedence", () => {
  test("a later `!` rule re-includes", () => {
    const m = root("*.log\n!keep.log\n");
    expect(m.isIgnored("a.log", false)).toBe(true);
    expect(m.isIgnored("keep.log", false)).toBe(false);
  });

  test("order matters — a later exclude beats an earlier negation", () => {
    const m = root("!keep.log\n*.log\n");
    expect(m.isIgnored("keep.log", false)).toBe(true);
  });

  test("a file cannot be re-included when its parent directory is excluded", () => {
    // This is git's documented behavior, and it is what makes pruning sound.
    const m = root("dist/\n!dist/keep.txt\n");
    expect(m.isIgnored("dist/keep.txt", false)).toBe(true);
  });

  test("re-inclusion works when the parent itself was never excluded", () => {
    const m = root("dist/*\n!dist/keep.txt\n");
    expect(m.isIgnored("dist/other.txt", false)).toBe(true);
    expect(m.isIgnored("dist/keep.txt", false)).toBe(false);
  });

  test("`\\!` is a literal bang, not a negation", () => {
    expect(root("\\!important").isIgnored("!important", false)).toBe(true);
  });
});

describe("nested .gitignore files", () => {
  test("a nested file only governs its own subtree", () => {
    const m = new GitignoreMatcher();
    m.add("", "");
    m.add("packages/cli", "generated");
    expect(m.isIgnored("packages/cli/generated", true)).toBe(true);
    expect(m.isIgnored("packages/server/generated", true)).toBe(false);
    expect(m.isIgnored("generated", true)).toBe(false);
  });

  test("a nested rule overrides a shallower one", () => {
    const m = new GitignoreMatcher();
    m.add("", "*.log");
    m.add("logs", "!*.log");
    expect(m.isIgnored("a.log", false)).toBe(true);
    expect(m.isIgnored("logs/a.log", false)).toBe(false);
  });

  test("an unmatched path is not ignored", () => {
    expect(root("*.log").isIgnored("src/index.ts", false)).toBe(false);
  });

  test("an empty matcher ignores nothing", () => {
    const m = new GitignoreMatcher();
    expect(m.isEmpty).toBe(true);
    expect(m.isIgnored("anything/at/all.ts", false)).toBe(false);
  });

  test("a .gitignore with only comments contributes no layer", () => {
    const m = new GitignoreMatcher();
    m.add("", "# nothing here\n\n");
    expect(m.isEmpty).toBe(true);
  });
});

describe("realistic project ignores", () => {
  const m = root(
    ["node_modules/", "dist/", "build/", "*.tsbuildinfo", "coverage/", ".env*", "!.env.example"].join(
      "\n",
    ),
  );

  test("dependency and build output are ignored", () => {
    expect(m.isIgnored("node_modules", true)).toBe(true);
    expect(m.isIgnored("packages/cli/dist", true)).toBe(true);
    expect(m.isIgnored("build", true)).toBe(true);
    expect(m.isIgnored("packages/server/tsconfig.tsbuildinfo", false)).toBe(true);
  });

  test("source is not ignored", () => {
    expect(m.isIgnored("packages/cli/src/index.tsx", false)).toBe(false);
    expect(m.isIgnored("CLAUDE.md", false)).toBe(false);
  });

  test("the negated example env file survives", () => {
    expect(m.isIgnored(".env", false)).toBe(true);
    expect(m.isIgnored(".env.local", false)).toBe(true);
    expect(m.isIgnored(".env.example", false)).toBe(false);
  });
});
