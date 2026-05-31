// Shared types for the MCP host (M1).
//
// The on-the-wire tool name convention is `mcp__<server>__<tool>`. This avoids
// dots (which some upstream provider validators reject), keeps the prefix easy
// to detect in dispatch, and matches Anthropic / Claude Desktop's format.

export const MCP_TOOL_NAME_PREFIX = "mcp__";

// stdio is the only transport in M1. Streamable HTTP is deferred.
export type McpStdioServerConfig = {
  transport: "stdio";
  command: string;
  args?: string[];
  // Extra env merged over the parent process env when spawning the child.
  env?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig;

export type McpConfigFile = {
  servers: Record<string, McpServerConfig>;
};

// Schema for a discovered MCP tool, in the shape we send to the server in the
// chat request body so it can be merged into the AI SDK tool contracts.
export type McpToolDescriptor = {
  // The wire-format name (e.g. `mcp__github__create_issue`). The server uses
  // this string verbatim when constructing the AI SDK tool definition and
  // when validating tool calls in `validateUIMessages`.
  name: string;
  // The plain server-local tool name (e.g. `create_issue`), used internally
  // when calling `tools/call` back through the MCP client.
  localName: string;
  // The server label from `mcp.json` (e.g. `github`). Used for permission
  // prompts and audit log entries.
  serverName: string;
  description: string;
  // JSON Schema for the tool's input. Forwarded as-is to the server, which
  // wraps it with the AI SDK's `jsonSchema()` helper.
  inputSchema: unknown;
};

export function buildMcpToolName(serverName: string, localName: string): string {
  return `${MCP_TOOL_NAME_PREFIX}${serverName}__${localName}`;
}

export type ParsedMcpToolName = {
  serverName: string;
  localName: string;
};

// Split `mcp__github__create_issue` -> { serverName: "github", localName: "create_issue" }.
// Returns null for any name that doesn't carry the prefix or is malformed.
export function parseMcpToolName(name: string): ParsedMcpToolName | null {
  if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep === rest.length - 2) return null;
  return {
    serverName: rest.slice(0, sep),
    localName: rest.slice(sep + 2),
  };
}
