import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpConfigFile, McpServerConfig } from "./types";

// Layering: global `~/.darkcode/mcp.json` is loaded first, then the project's
// `.darkcode/mcp.json` is merged on top. Project entries override global
// entries with the same server name — local development setups should always
// win over personal defaults.
function projectConfigPath(cwd: string): string {
  return join(cwd, ".darkcode", "mcp.json");
}

function globalConfigPath(): string {
  return join(homedir(), ".darkcode", "mcp.json");
}

// MCP server names must be safe to embed in a wire tool name (mcp__<name>__tool).
// Allow letters, digits, underscores, and hyphens. No dots, no double underscores.
const VALID_SERVER_NAME = /^[A-Za-z0-9-]+$/;

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseServerConfig(name: string, raw: unknown): McpServerConfig | null {
  if (!isStringRecord(raw)) return null;
  if (raw.transport !== "stdio") return null; // HTTP deferred to M2
  if (typeof raw.command !== "string" || raw.command.length === 0) return null;

  const args = Array.isArray(raw.args)
    ? raw.args.filter((a): a is string => typeof a === "string")
    : undefined;

  const env = isStringRecord(raw.env)
    ? Object.fromEntries(
        Object.entries(raw.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;

  return {
    transport: "stdio",
    command: raw.command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
  };
}

function readServersFrom(path: string): Record<string, McpServerConfig> {
  if (!existsSync(path)) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // Malformed JSON shouldn't crash the CLI; surface as no servers configured.
    return {};
  }

  if (!isStringRecord(raw) || !isStringRecord(raw.servers)) {
    return {};
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw.servers)) {
    if (!VALID_SERVER_NAME.test(name)) continue;
    const parsed = parseServerConfig(name, value);
    if (parsed) servers[name] = parsed;
  }
  return servers;
}

// Load + validate the effective MCP config: global first, then project on top.
// Missing or malformed files at either layer are treated as absent. MCP is
// opt-in, so an empty result is the normal case, not an error.
export function loadMcpConfig(cwd: string = process.cwd()): McpConfigFile {
  const globalServers = readServersFrom(globalConfigPath());
  const projectServers = readServersFrom(projectConfigPath(cwd));
  return { servers: { ...globalServers, ...projectServers } };
}

// For UI affordances that need to label entries by source layer (the /mcp
// viewer shows "global" vs "project").
export function loadMcpConfigLayers(cwd: string = process.cwd()): {
  global: Record<string, McpServerConfig>;
  project: Record<string, McpServerConfig>;
} {
  return {
    global: readServersFrom(globalConfigPath()),
    project: readServersFrom(projectConfigPath(cwd)),
  };
}
