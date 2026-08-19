import { TextAttributes } from "@opentui/core";
import { useTheme } from "../providers/theme";
import { useUpdateStatus } from "../hooks/use-update-status";

/**
 * The version line under the wordmark. It answers "am I current?", not just
 * "what am I running?": once the latest release is known it either confirms
 * this build is up to date or names the version to upgrade to. Until the check
 * resolves (or when it can't reach GitHub) it degrades to the bare version.
 */
function VersionLine() {
  const status = useUpdateStatus();
  const { colors } = useTheme();

  if (!status) return null;

  // Source runs report "dev", which reads wrong as "vdev".
  const label = status.current === "dev" ? "dev" : `v${status.current}`;

  if (status.updateAvailable) {
    return (
      <text fg={colors.info}>
        {label} → v{status.latest} available
      </text>
    );
  }

  return (
    <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
      {status.latest ? `${label} · latest` : label}
    </text>
  );
};

export function Header() {
  return (
    <box justifyContent="center" alignItems="center" gap={1}>
      <box flexDirection="row" justifyContent="center" gap={0.5} alignItems="center">
        <ascii-font font="tiny" text="Dark" color="gray" />
        <ascii-font font="tiny" text="Code" />
      </box>
      <VersionLine />
    </box>
  );
};
