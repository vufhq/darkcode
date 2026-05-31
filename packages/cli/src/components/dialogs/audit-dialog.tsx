import { useMemo } from "react";
import { TextAttributes } from "@opentui/core";
import { format } from "date-fns";
import { DialogSearchList } from "../dialog-search-list";
import { useTheme } from "../../providers/theme";
import { readRecentAudit, type AuditEntry } from "../../lib/permissions/audit";

const AUDIT_LIMIT = 100;

function decisionColor(decision: AuditEntry["decision"]): string {
  switch (decision) {
    case "allow":
      return "green";
    case "deny":
      return "red";
    default:
      return "yellow";
  }
}

export const AuditDialogContent = () => {
  const { colors } = useTheme();
  const entries = useMemo(() => readRecentAudit(AUDIT_LIMIT), []);

  if (entries.length === 0) {
    return (
      <box flexDirection="column" paddingX={1}>
        <text attributes={TextAttributes.DIM}>
          No audit entries yet — the log fills as tools run.
        </text>
      </box>
    );
  }

  return (
    <DialogSearchList
      items={entries}
      onSelect={() => {}}
      filterFn={(entry, query) => {
        const q = query.toLowerCase();
        return (
          entry.tool.toLowerCase().includes(q) ||
          entry.summary.toLowerCase().includes(q) ||
          entry.decision.toLowerCase().includes(q)
        );
      }}
      renderItem={(entry, isSelected) => (
        <>
          <text
            selectable={false}
            fg={isSelected ? "black" : decisionColor(entry.decision)}
          >
            {entry.decision.padEnd(5)}
          </text>
          <text
            selectable={false}
            fg={isSelected ? "black" : colors.dimSeparator}
            attributes={TextAttributes.DIM}
          >
            {" "}
            {entry.tool}{" "}
          </text>
          <text selectable={false} fg={isSelected ? "black" : "white"}>
            {entry.summary.length > 60
              ? `${entry.summary.slice(0, 60)}…`
              : entry.summary}
          </text>
          <box flexGrow={1} />
          <text
            selectable={false}
            fg={isSelected ? "black" : undefined}
            attributes={TextAttributes.DIM}
          >
            {format(new Date(entry.ts), "MM/dd HH:mm")}
          </text>
        </>
      )}
      getKey={(entry) => `${entry.ts}-${entry.tool}-${entry.summary}`}
      placeholder="Search audit log"
      emptyText="No matching entries"
    />
  );
};
