---
name: darkcode-p6-mcp-m2
description: Finish Phase 6 (MCP M2) of the DarkCode plan — Streamable HTTP transport, lifecycle (health probes / restart-on-crash / idle shutdown), and `/mcp add | remove | logs` commands. M1 (stdio host, project + global config, tool catalog viewer) is already shipped. Use when the user asks to extend MCP support beyond stdio or improve MCP reliability.
model: sonnet
---

# DarkCode P6 — MCP M2 leftovers

M1 is shipped: stdio host, project + global `.darkcode/mcp.json` layering, tool discovery, `mcp__*` dispatch from `useChat.onToolCall`, permission gate, and the `/mcp` viewer.

You are completing M2:

1. **Streamable HTTP transport** alongside stdio.
2. **Lifecycle management** — health probes, restart-on-crash with backoff, idle shutdown.
3. **`/mcp add | remove | logs`** commands.

## Read first

- `packages/cli/src/lib/mcp/` — current M1 host. Key files: `config.ts` (layered config loader), `host.ts` (connect / dispatch), `types.ts`, `index.ts`.
- `darkcode-cli-implementation-plan.md` §8 for the design.

## Success criteria

### HTTP transport
- Extend `McpServerConfig` with an `http` variant: `{ transport: "http", url: string, headers?: Record<string, string> }`.
- Use `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport` (or its successor in the SDK version pinned in `package.json`).
- The config validator (`parseServerConfig` in `config.ts`) must accept both `stdio` and `http` entries cleanly.

### Lifecycle
- Health probe: every 60s, call a cheap MCP method (e.g. `ping` if supported, else `tools/list` with cached result discarded). On three consecutive failures, mark unhealthy.
- Restart with exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, capped. Reset on a successful health check.
- Idle shutdown: if no tool has been called for 10 minutes, disconnect the client and the transport; reconnect lazily on next call. The existing `connecting` / `connected` maps in `host.ts` already model lazy connect — reuse them.
- Per-server status accessible via a new `getServerStatuses()` API in `mcp/index.ts` for the viewer.

### Commands
- `/mcp add` — open a small form dialog to add a stdio or http server, write to the project `.darkcode/mcp.json`.
- `/mcp remove` — pick a server from the merged list and delete it from whichever layer it came from. Block deletion of global entries if the user is in a project that doesn't own them — show a clear message.
- `/mcp logs` — show the last N stderr lines from each server. Requires capturing stderr; the current host sets `stderr: "pipe"` but discards it. Pipe it into an in-memory ring buffer (max 200 lines per server).

## Constraints

- Don't redesign the M1 wire format (`mcp__<server>__<tool>`).
- Don't break the chat route's tool-merge logic; M2 is purely CLI-side host work.
- All side effects still pass through `checkPermission({ kind: "mcp", ... })`.
- A crashing or unhealthy server must NEVER block the CLI startup or a chat turn — its tools just disappear from the catalog until it recovers.

## Out of scope

- Resources & prompts (the plan defers these explicitly).
- Tool list-changed notifications (`notifications/tools/list_changed`).
- Per-tool retry policy. M2 only handles per-connection retry.

When done, run with a misbehaving stdio server (e.g. one that exits after a few seconds) and confirm the restart + health flow keeps the CLI usable.
