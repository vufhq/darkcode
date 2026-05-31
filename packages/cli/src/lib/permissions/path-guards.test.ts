import { describe, expect, test } from "bun:test";

import { classifyFsWrite, globToRegex } from "./path-guards";
import { DEFAULT_POLICY } from "./defaults";
import type { FsRules } from "./types";

describe("globToRegex", () => {
  test("`*` matches within a single path segment but not across `/`", () => {
    const re = globToRegex("src/*.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/nested/index.ts")).toBe(false);
  });

  test("`**` matches across path separators", () => {
    const re = globToRegex("src/**/*.ts");
    expect(re.test("src/a/b/c.ts")).toBe(true);
    expect(re.test("src/c.ts")).toBe(true);
  });

  test("a leading `**/` matches zero leading segments", () => {
    const re = globToRegex("**/*.pem");
    expect(re.test("key.pem")).toBe(true);
    expect(re.test("certs/key.pem")).toBe(true);
  });

  test("`?` matches a single non-separator character", () => {
    const re = globToRegex("file?.ts");
    expect(re.test("file1.ts")).toBe(true);
    expect(re.test("file.ts")).toBe(false);
    expect(re.test("file12.ts")).toBe(false);
  });

  test("escapes regex metacharacters in literal segments", () => {
    const re = globToRegex(".env.local");
    expect(re.test(".env.local")).toBe(true);
    // The dots are literal, not 'any char' — a different separator must fail.
    expect(re.test("xenvxlocal")).toBe(false);
  });

  test("is anchored at both ends", () => {
    const re = globToRegex("config.json");
    expect(re.test("config.json")).toBe(true);
    expect(re.test("my-config.json")).toBe(false);
    expect(re.test("config.json.bak")).toBe(false);
  });
});

describe("classifyFsWrite with synthetic rules", () => {
  const rules: FsRules = {
    allowWrite: ["src/**"],
    denyWrite: ["**/*.pem", "**/secrets/**"],
  };

  test("allows a write under an allowed path", () => {
    expect(classifyFsWrite("src/index.ts", rules).decision).toBe("allow");
  });

  test("denies a write matching a deny rule", () => {
    const out = classifyFsWrite("certs/server.pem", rules);
    expect(out.decision).toBe("deny");
    expect(out.matchedRule).toBe("**/*.pem");
  });

  test("deny takes precedence over allow", () => {
    // Inside the allowed `src/**`, but a `.pem` there is still denied.
    expect(classifyFsWrite("src/secrets/key.pem", rules).decision).toBe("deny");
  });

  test("asks for a path covered by neither list", () => {
    const out = classifyFsWrite("README.md", rules);
    expect(out.decision).toBe("ask");
    expect(out.matchedRule).toBe("");
  });
});

describe("classifyFsWrite path normalization", () => {
  const rules: FsRules = { allowWrite: ["src/**"], denyWrite: [] };

  test("normalizes Windows backslashes to forward slashes", () => {
    expect(classifyFsWrite("src\\components\\App.tsx", rules).decision).toBe(
      "allow",
    );
  });

  test("strips a leading ./", () => {
    expect(classifyFsWrite("./src/index.ts", rules).decision).toBe("allow");
  });
});

describe("classifyFsWrite with the shipped DEFAULT_POLICY", () => {
  const rules = DEFAULT_POLICY.fs;

  test("allows ordinary project files (allowWrite is **)", () => {
    expect(classifyFsWrite("src/index.ts", rules).decision).toBe("allow");
    expect(classifyFsWrite("package.json", rules).decision).toBe("allow");
  });

  test("denies writes to secret files anywhere in the tree", () => {
    expect(classifyFsWrite(".env", rules).decision).toBe("deny");
    expect(classifyFsWrite(".env.production", rules).decision).toBe("deny");
    expect(classifyFsWrite("config/.env", rules).decision).toBe("deny");
    expect(classifyFsWrite("certs/server.pem", rules).decision).toBe("deny");
    expect(classifyFsWrite("deploy/id_rsa", rules).decision).toBe("deny");
    expect(classifyFsWrite(".ssh/config", rules).decision).toBe("deny");
    expect(classifyFsWrite("home/.aws/credentials", rules).decision).toBe("deny");
  });

  test("a root-level secret (no leading dir) is still denied", () => {
    // The `**/` prefix must match zero leading segments for this to work.
    expect(classifyFsWrite("server.key", rules).decision).toBe("deny");
  });
});
