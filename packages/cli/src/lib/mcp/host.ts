import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scrubCredentialEnv } from "../scrubbed-env";
import { loadMcpConfig } from "./config";
import {
  buildMcpToolName,
  parseMcpToolName,
  type McpServerConfig,
  type McpToolDescriptor,
} from "./types";

// One connected MCP server. The Client + Transport are kept warm for the
// lifetime of the CLI process; M2 will add health probes and restart-on-crash.
type ConnectedServer = {
  serverName: string;
  config: McpServerConfig;
  client: Client;
  // Tools as the server advertised them on the most recent `tools/list` call.
  // Re-fetched lazily on demand if the cache is stale (M2 will subscribe to
  // `notifications/tools/list_changed` for proactive invalidation).
  tools: McpToolDescriptor[];
};

const connected = new Map<string, ConnectedServer>();
// In-flight connect promises to dedupe concurrent first-use calls.
const connecting = new Map<string, Promise<ConnectedServer>>();

async function connect(
  serverName: string,
  config: McpServerConfig,
): Promise<ConnectedServer> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    // Spawn with a credential-scrubbed copy of the parent env (same containment
    // the `bash` tool gets), then layer any server-specific vars from mcp.json
    // on top. Never hand a server our raw process.env — that would leak the
    // user's API keys/tokens to any (possibly project-supplied) MCP server.
    env: { ...scrubCredentialEnv(), ...config.env },
    // Avoid drowning the user's terminal in the child's stderr; "pipe" sends
    // it to the SDK which discards by default. The CLI's audit log will
    // capture call-level errors instead.
    stderr: "pipe",
  });

  const client = new Client(
    { name: "darkcode-cli", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  const listed = await client.listTools();
  const tools: McpToolDescriptor[] = listed.tools.map((tool) => ({
    name: buildMcpToolName(serverName, tool.name),
    localName: tool.name,
    serverName,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
  }));

  return { serverName, config, client, tools };
}

async function ensureConnected(serverName: string): Promise<ConnectedServer> {
  const existing = connected.get(serverName);
  if (existing) return existing;

  const inflight = connecting.get(serverName);
  if (inflight) return inflight;

  const config = loadMcpConfig().servers[serverName];
  if (!config) {
    throw new Error(`MCP server "${serverName}" is not declared in .darkcode/mcp.json`);
  }

  const promise = connect(serverName, config)
    .then((srv) => {
      connected.set(serverName, srv);
      connecting.delete(serverName);
      return srv;
    })
    .catch((err) => {
      connecting.delete(serverName);
      throw err;
    });

  connecting.set(serverName, promise);
  return promise;
}

// Discover tools for every declared server. Used at session start to build the
// catalog the CLI bundles into each chat request. Servers that fail to
// connect are skipped — a single broken server shouldn't block the rest.
export async function discoverAllMcpTools(): Promise<McpToolDescriptor[]> {
  const config = loadMcpConfig();
  const serverNames = Object.keys(config.servers);
  if (serverNames.length === 0) return [];

  const results = await Promise.allSettled(
    serverNames.map((name) => ensureConnected(name)),
  );

  const tools: McpToolDescriptor[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") tools.push(...result.value.tools);
  }
  return tools;
}

// Execute an MCP tool call. `toolName` is the wire-format name (`mcp__...`);
// the host parses it, ensures the relevant server is connected, and forwards
// `tools/call`. Returns whatever the server returned in `content` plus any
// structured payload, matching the shape the AI SDK expects from a tool
// output.
export async function callMcpTool(
  toolName: string,
  args: unknown,
): Promise<unknown> {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) {
    throw new Error(`Not an MCP tool name: ${toolName}`);
  }

  const server = await ensureConnected(parsed.serverName);

  const result = await server.client.callTool({
    name: parsed.localName,
    arguments: (args ?? {}) as Record<string, unknown>,
  });

  if (result.isError) {
    const text =
      Array.isArray(result.content) && result.content.length > 0
        ? extractText(result.content[0])
        : "MCP tool call failed";
    throw new Error(text);
  }

  // Preserve both the structured + content forms — agents downstream may want
  // either depending on the tool.
  return {
    content: result.content,
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
  };
}

function extractText(part: unknown): string {
  if (part && typeof part === "object" && "text" in part) {
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "MCP tool call failed";
}
