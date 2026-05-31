import { TextAttributes } from "@opentui/core";
import { useTheme } from "../providers/theme";
import { usePromptConfig } from "../providers/prompt-config";
import { Mode, getModelDisplayName } from "@darkcode/shared";

export function StatusBar() {
  const { mode, model, contextUsage, posture } = usePromptConfig();
  const { colors } = useTheme();
  const postureColor =
    posture === "yolo" ? "red" : posture === "auto-edit" ? "yellow" : undefined;

  const usagePercent = contextUsage
    ? contextUsage.estimatedTokens / contextUsage.contextWindow
    : null;
  const usageColor =
    usagePercent == null
      ? undefined
      : usagePercent >= 0.9
        ? "red"
        : usagePercent >= 0.75
          ? "yellow"
          : undefined;

  return (
    <box flexDirection="row" gap={1}>

      <text fg={mode === Mode.PLAN ? colors.planMode : colors.primary}>
        {mode === Mode.PLAN ? "Plan" : "Build"}
      </text>

      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        ›
      </text>
      <text>{getModelDisplayName(model)}</text>

      {posture !== "normal" && (
        <>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            ›
          </text>
          <text fg={postureColor}>
            {posture === "yolo" ? "YOLO" : "auto-edit"}
          </text>
        </>
      )}

      {contextUsage && (
        <>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            ›
          </text>
          <text attributes={TextAttributes.DIM} fg={usageColor}>
            ctx {contextUsage.estimatedTokens}/{contextUsage.contextWindow} (
            {((contextUsage.estimatedTokens / contextUsage.contextWindow) * 100).toFixed(0)}%)
          </text>
        </>
      )}
    </box>
  );
};
