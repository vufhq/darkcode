import { useCallback, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useDialog } from "../../providers/dialog";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import type { PermissionRequest, UserResponse } from "../../lib/permissions/types";

type PermissionDialogContentProps = {
  request: PermissionRequest;
  onResolve: (response: UserResponse) => void;
};

type Choice = "allow_once" | "allow_always" | "deny";

const CHOICES: { value: Choice; label: string; description: string }[] = [
  { value: "allow_once", label: "Allow once", description: "Run this single call" },
  {
    value: "allow_always",
    label: "Allow always",
    description: "Save a rule to the project policy",
  },
  { value: "deny", label: "Deny", description: "Reject this call" },
];

export function PermissionDialogContent({
  request,
  onResolve,
}: PermissionDialogContentProps) {
  const dialog = useDialog();
  const { isTopLayer } = useKeyboardLayer();
  const [index, setIndex] = useState(0);

  const choose = useCallback(
    (choice: Choice) => {
      onResolve({ decision: choice });
      dialog.close();
    },
    [dialog, onResolve],
  );

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;
    if (key.name === "up") {
      setIndex((i) => (i - 1 + CHOICES.length) % CHOICES.length);
      return;
    }
    if (key.name === "down") {
      setIndex((i) => (i + 1) % CHOICES.length);
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      choose(CHOICES[index]!.value);
      return;
    }
    if (key.name === "y") {
      choose("allow_once");
      return;
    }
    if (key.name === "a") {
      choose("allow_always");
      return;
    }
    if (key.name === "n") {
      choose("deny");
    }
  });

  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.DIM}>
        DarkCode wants to run a {request.tool} operation:
      </text>
      <text attributes={TextAttributes.BOLD}>{request.summary}</text>
      <text attributes={TextAttributes.DIM}>{request.reason}</text>
      <box flexDirection="column" paddingTop={1}>
        {CHOICES.map((choice, i) => (
          <box
            key={choice.value}
            flexDirection="row"
            gap={1}
            paddingX={1}
          >
            <text fg={i === index ? "white" : "gray"}>
              {i === index ? ">" : " "}
            </text>
            <text fg={i === index ? "white" : "gray"}>{choice.label}</text>
            <text attributes={TextAttributes.DIM} fg="gray">
              {choice.description}
            </text>
          </box>
        ))}
      </box>
      <text attributes={TextAttributes.DIM}>
        ↑/↓ + enter · or y / a / n
      </text>
    </box>
  );
}
