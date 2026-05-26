import type { ReactNode } from "react";

export type DialogConfig = {
  title: string;
  children: ReactNode;
  // Optional callback fired when the dialog is dismissed for any reason
  // (escape, click-outside, or programmatic close). The permission flow
  // uses this to treat a dismissal as "deny" so the engine's promise
  // always resolves.
  onClose?: () => void;
};
