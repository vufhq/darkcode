import type { DecisionOutcome, McpRules } from "./types";

// Pattern matcher for MCP tool names. Splits on `__` (the same separator used
// in the wire format) and matches segment-by-segment.
//
//   `*`  matches exactly one segment (between two `__`)
//   `**` matches zero or more remaining segments — only valid as the final
//        pattern segment
//
// Examples (against `mcp__github__create_issue`):
//   `mcp__github__create_issue` → exact match
//   `mcp__github__*`           → matches any github tool
//   `mcp__**`                  → matches any MCP tool
//   `mcp__*__create_issue`     → matches `create_issue` from any server
function splitSegments(value: string): string[] {
  return value.split("__");
}

export function matchesMcpPattern(toolName: string, pattern: string): boolean {
  const nameSegments = splitSegments(toolName);
  const patternSegments = splitSegments(pattern);

  let pi = 0;
  let ni = 0;
  while (pi < patternSegments.length) {
    const ps = patternSegments[pi]!;
    if (ps === "**") return pi === patternSegments.length - 1;
    if (ni >= nameSegments.length) return false;
    if (ps !== "*" && ps !== nameSegments[ni]) return false;
    pi++;
    ni++;
  }
  return ni === nameSegments.length;
}

function firstMatch(toolName: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (matchesMcpPattern(toolName, pattern)) return pattern;
  }
  return null;
}

// Classify an MCP tool call against the loaded policy. Deny-first, then allow,
// then ask; unmatched falls through to ask.
export function classifyMcpCall(toolName: string, rules: McpRules): DecisionOutcome {
  const denied = firstMatch(toolName, rules.deny);
  if (denied) {
    return {
      decision: "deny",
      reason: `Tool "${toolName}" matches deny rule`,
      matchedRule: denied,
    };
  }

  const allowed = firstMatch(toolName, rules.allow);
  if (allowed) {
    return {
      decision: "allow",
      reason: `Tool "${toolName}" matches allow rule`,
      matchedRule: allowed,
    };
  }

  const asked = firstMatch(toolName, rules.ask);
  return {
    decision: "ask",
    reason: asked
      ? `Tool "${toolName}" matches ask rule`
      : `Tool "${toolName}" has no matching policy`,
    matchedRule: asked ?? "",
  };
}
