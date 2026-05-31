import { useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import {
  discoverAllMcpTools,
  loadMcpConfigLayers,
  type McpServerConfig,
  type McpToolDescriptor,
} from "../../lib/mcp";

type Layered = {
  global: Record<string, McpServerConfig>;
  project: Record<string, McpServerConfig>;
};

type ServerRow = {
  name: string;
  source: "global" | "project";
  command: string;
};

function flattenLayers(layers: Layered): ServerRow[] {
  const rows: ServerRow[] = [];
  // Project overrides global; show only the effective row per name.
  const seen = new Set<string>();
  for (const [name, cfg] of Object.entries(layers.project)) {
    rows.push({ name, source: "project", command: renderCommand(cfg) });
    seen.add(name);
  }
  for (const [name, cfg] of Object.entries(layers.global)) {
    if (seen.has(name)) continue;
    rows.push({ name, source: "global", command: renderCommand(cfg) });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function renderCommand(cfg: McpServerConfig): string {
  const args = cfg.args && cfg.args.length > 0 ? ` ${cfg.args.join(" ")}` : "";
  return `${cfg.command}${args}`;
}

export const McpDialogContent = () => {
  const [rows] = useState<ServerRow[]>(() => flattenLayers(loadMcpConfigLayers()));
  const [tools, setTools] = useState<McpToolDescriptor[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void discoverAllMcpTools()
      .then((discovered) => {
        if (!cancelled) setTools(discovered);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (rows.length === 0) {
    return (
      <box flexDirection="column" paddingX={1}>
        <text attributes={TextAttributes.DIM}>
          No MCP servers declared. Add one to .darkcode/mcp.json or ~/.darkcode/mcp.json.
        </text>
      </box>
    );
  }

  return (
    <scrollbox height={20}>
      <box flexDirection="column" paddingX={1} gap={1}>
        {rows.map((row) => {
          const serverTools = tools?.filter((t) => t.serverName === row.name) ?? [];
          return (
            <box key={row.name} flexDirection="column">
              <box flexDirection="row" gap={1}>
                <text fg="white">{row.name}</text>
                <text attributes={TextAttributes.DIM} fg="gray">
                  [{row.source}]
                </text>
              </box>
              <text attributes={TextAttributes.DIM}>{"  "}{row.command}</text>
              {tools === null ? (
                <text attributes={TextAttributes.DIM}>{"  "}discovering tools…</text>
              ) : serverTools.length === 0 ? (
                <text attributes={TextAttributes.DIM} fg="yellow">
                  {"  "}no tools (connection failed or empty catalog)
                </text>
              ) : (
                serverTools.map((tool) => (
                  <text
                    key={tool.name}
                    attributes={TextAttributes.DIM}
                    fg="green"
                  >
                    {"  "}{tool.localName}
                  </text>
                ))
              )}
            </box>
          );
        })}
        {error && (
          <text fg="red">{error}</text>
        )}
      </box>
    </scrollbox>
  );
};
