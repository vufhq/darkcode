import { TextAttributes } from "@opentui/core";
import { useTheme } from "../providers/theme";
import { usePromptConfig } from "../providers/prompt-config";
import { Mode, findSupportedChatModel, getModelDisplayName } from "@darkcode/shared";

// Low-balance thresholds (1 credit = $0.01). A substantial agentic session runs
// ~20–35 credits, so <50 (≈one or two sessions left) warns amber and <10 turns
// red. Tune alongside the free-grant size in MONETIZATION.md.
const CREDITS_LOW = 50;
const CREDITS_CRITICAL = 10;

function creditsColor(credits: number): string | undefined {
  if (credits < CREDITS_CRITICAL) return "red";
  if (credits < CREDITS_LOW) return "yellow";
  return undefined;
}

export function StatusBar() {
  const { mode, model, contextUsage, credits, posture } = usePromptConfig();
  const { colors } = useTheme();
  const postureColor =
    posture === "yolo" ? "red" : posture === "auto-edit" ? "yellow" : undefined;

  // Credits only gate hosted turns, so only surface the gauge on the hosted
  // model. `credits` is null until first fetched (render nothing); an
  // "unavailable" state renders a dim em-dash, never a misleading 0.
  const isHostedModel = findSupportedChatModel(model)?.provider === "darkcode";

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

      {isHostedModel && credits && (
        <>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            ›
          </text>
          {credits.status === "ok" ? (
            <text fg={creditsColor(credits.credits)}>{credits.credits} cr</text>
          ) : (
            <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
              cr —
            </text>
          )}
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
