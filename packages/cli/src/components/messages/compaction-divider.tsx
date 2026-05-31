import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../providers/theme";

type Props = {
  droppedCount: number;
};

export function CompactionDivider({ droppedCount }: Props) {
  const { colors } = useTheme();
  const label =
    droppedCount === 1
      ? "summarized 1 earlier message"
      : `summarized ${droppedCount} earlier messages`;

  return (
    <box
      width="100%"
      flexDirection="row"
      alignItems="center"
      paddingX={3}
      paddingY={1}
      gap={1}
    >
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        ──
      </text>
      <text attributes={TextAttributes.DIM} fg={colors.info}>
        ⤳ {label}
      </text>
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        ──
      </text>
    </box>
  );
}
