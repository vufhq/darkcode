import { useMemo } from "react";
import { TextAttributes } from "@opentui/core";
import { loadPolicy } from "../../lib/permissions/policy";
import { usePromptConfig } from "../../providers/prompt-config";

type Section = {
  label: string;
  color: string;
  rules: string[];
};

export const PermissionsDialogContent = () => {
  const { posture } = usePromptConfig();
  const policy = useMemo(() => loadPolicy(), []);

  const sections: Section[] = [
    { label: "bash.allow", color: "green", rules: policy.bash.allow },
    { label: "bash.ask", color: "yellow", rules: policy.bash.ask },
    { label: "bash.deny", color: "red", rules: policy.bash.deny },
    { label: "fs.allowWrite", color: "green", rules: policy.fs.allowWrite },
    { label: "fs.denyWrite", color: "red", rules: policy.fs.denyWrite },
    { label: "mcp.allow", color: "green", rules: policy.mcp.allow },
    { label: "mcp.ask", color: "yellow", rules: policy.mcp.ask },
    { label: "mcp.deny", color: "red", rules: policy.mcp.deny },
  ];

  return (
    <scrollbox height={20}>
      <box flexDirection="column" paddingX={1} gap={1}>
        <box flexDirection="row" gap={1}>
          <text attributes={TextAttributes.DIM}>posture:</text>
          <text
            fg={
              posture === "yolo"
                ? "red"
                : posture === "auto-edit"
                  ? "yellow"
                  : undefined
            }
          >
            {posture}
          </text>
        </box>
        {sections.map((section) => (
          <box key={section.label} flexDirection="column">
            <text fg={section.color}>{section.label}</text>
            {section.rules.length === 0 ? (
              <text attributes={TextAttributes.DIM}> (empty)</text>
            ) : (
              section.rules.map((rule, i) => (
                <text key={`${section.label}-${i}`} attributes={TextAttributes.DIM}>
                  {"  "}
                  {rule}
                </text>
              ))
            )}
          </box>
        ))}
      </box>
    </scrollbox>
  );
};
