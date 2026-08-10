// Permission engine types.
//
// A `Policy` is the in-memory representation of the user's ruleset. It is
// loaded from layered JSON files (project overrides global) and consulted on
// every side-effecting tool call. Rules are pattern strings — for bash they
// match against the parsed leading command of each shell segment, for fs they
// match against project-relative paths via globs.

export type BashRules = {
  allow: string[];
  deny: string[];
  ask: string[];
};

export type FsRules = {
  allowWrite: string[];
  denyWrite: string[];
  // Paths whose *contents* must never reach the model. Reads are otherwise
  // unrestricted; this list is a hard deny, not a prompt. Kept separate from
  // `denyWrite` because the two protect against different things — clobbering
  // a secret vs. exfiltrating one — even though they seed from the same globs.
  denyRead: string[];
};

// MCP rules match against the wire-format tool name (`mcp__<server>__<tool>`).
// `*` matches a single segment between `__` separators; `**` matches all
// remaining segments. So `mcp__github__*` allows every github tool, and
// `mcp__**` allows everything from every MCP server.
export type McpRules = {
  allow: string[];
  deny: string[];
  ask: string[];
};

export type Policy = {
  bash: BashRules;
  fs: FsRules;
  mcp: McpRules;
};

export type Decision = "allow" | "deny" | "ask";

export type DecisionOutcome = {
  decision: Decision;
  // Human-readable explanation surfaced in the prompt UI and audit log.
  reason: string;
  // The matched rule pattern, if any. Empty string when the decision falls
  // through to the default.
  matchedRule: string;
};

// A request that the engine needs the user to resolve interactively.
export type PermissionRequest = {
  tool: string;
  // For bash: the raw command. For fs: the resolved project-relative path.
  summary: string;
  reason: string;
};

// The user's interactive response.
export type UserResponse =
  | { decision: "allow_once" }
  | { decision: "allow_always" }
  | { decision: "deny" };
