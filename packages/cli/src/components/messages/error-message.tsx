import { TextAttributes } from "@opentui/core";
import { EmptyBorder } from "../border";
import { useTheme } from "../../providers/theme";

type Props = {
  message: string;
  // Optional call-to-action rendered below the message in an accent color (not
  // dim), so an actionable, recoverable error (e.g. out of credits) reads as a
  // next step rather than a crash.
  hint?: string;
};

export function ErrorMessage({ message, hint }: Props) {
  const { colors } = useTheme();

  return (
    <box width="100%" alignItems="center">
      <box
        border={["left"]}
        borderColor={colors.error}
        width="100%"
        customBorderChars={{
          ...EmptyBorder,
          vertical: "┃",
          bottomLeft: "╹",
        }}
      >
        <box
          flexDirection="column"
          paddingX={2}
          paddingY={1}
          gap={hint ? 1 : 0}
          backgroundColor={colors.surface}
          width="100%"
        >
          <text attributes={TextAttributes.DIM}>{message}</text>
          {hint ? <text fg={colors.primary}>{hint}</text> : null}
        </box>
      </box>
    </box>
  );
};
