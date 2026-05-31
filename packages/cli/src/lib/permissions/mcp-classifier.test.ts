import { describe, expect, test } from "bun:test";

import { classifyMcpCall, matchesMcpPattern } from "./mcp-classifier";
import { DEFAULT_POLICY } from "./defaults";
import type { McpRules } from "./types";

const TOOL = "mcp__github__create_issue";

describe("matchesMcpPattern", () => {
  test("matches an exact tool name", () => {
    expect(matchesMcpPattern(TOOL, "mcp__github__create_issue")).toBe(true);
  });

  test("`*` matches a single server segment", () => {
    expect(matchesMcpPattern(TOOL, "mcp__*__create_issue")).toBe(true);
  });

  test("`*` matches a single tool segment", () => {
    expect(matchesMcpPattern(TOOL, "mcp__github__*")).toBe(true);
  });

  test("`mcp__**` matches any MCP tool", () => {
    expect(matchesMcpPattern(TOOL, "mcp__**")).toBe(true);
    expect(matchesMcpPattern("mcp__slack__post_message", "mcp__**")).toBe(true);
  });

  test("`**` matches zero remaining segments", () => {
    expect(matchesMcpPattern("mcp__github", "mcp__github__**")).toBe(true);
  });

  test("a non-matching server segment fails", () => {
    expect(matchesMcpPattern(TOOL, "mcp__slack__*")).toBe(false);
  });

  test("`*` is a whole-segment wildcard, not an intra-segment glob", () => {
    // `delete_*` is a literal segment, NOT a prefix match on the tool name.
    expect(matchesMcpPattern("mcp__github__delete_repo", "mcp__github__delete_*")).toBe(
      false,
    );
  });

  test("a longer pattern than the name fails without trailing `**`", () => {
    expect(matchesMcpPattern("mcp__github", "mcp__github__create_issue")).toBe(false);
  });

  test("extra trailing segments on the name fail without `**`", () => {
    expect(matchesMcpPattern(TOOL, "mcp__github")).toBe(false);
  });
});

describe("classifyMcpCall", () => {
  test("deny takes precedence over allow", () => {
    const rules: McpRules = {
      deny: ["mcp__github__delete_repo"],
      allow: ["mcp__github__*"],
      ask: [],
    };
    const out = classifyMcpCall("mcp__github__delete_repo", rules);
    expect(out.decision).toBe("deny");
    expect(out.matchedRule).toBe("mcp__github__delete_repo");
  });

  test("allow takes precedence over ask", () => {
    const rules: McpRules = {
      deny: [],
      allow: ["mcp__github__*"],
      ask: ["mcp__**"],
    };
    expect(classifyMcpCall(TOOL, rules).decision).toBe("allow");
  });

  test("matches an ask rule", () => {
    const rules: McpRules = { deny: [], allow: [], ask: ["mcp__github__*"] };
    const out = classifyMcpCall(TOOL, rules);
    expect(out.decision).toBe("ask");
    expect(out.matchedRule).toBe("mcp__github__*");
  });

  test("falls through to ask with no matching policy", () => {
    const rules: McpRules = { deny: [], allow: [], ask: [] };
    const out = classifyMcpCall(TOOL, rules);
    expect(out.decision).toBe("ask");
    expect(out.matchedRule).toBe("");
    expect(out.reason).toContain("no matching policy");
  });

  test("the shipped DEFAULT_POLICY asks for every MCP tool", () => {
    const rules = DEFAULT_POLICY.mcp;
    expect(classifyMcpCall(TOOL, rules).decision).toBe("ask");
    expect(classifyMcpCall("mcp__anything__at_all", rules).decision).toBe("ask");
  });
});
