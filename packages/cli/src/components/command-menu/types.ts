import type { DialogContextValue } from "../../providers/dialog";
import type { ToastContextValue } from "../../providers/toast";
import type { ModeType, SupportedChatModelId } from "@darkcode/shared";
import type { PermissionPosture } from "../../lib/permissions/engine";

export type CommandContext = {
  exit: () => void;
  toast: ToastContextValue;
  dialog: DialogContextValue;
  navigate: (path: string) => void;
  mode: ModeType;
  setMode: (mode: ModeType) => void;
  model: SupportedChatModelId;
  setModel: (model: SupportedChatModelId) => void;
  // Present only when a session is active (i.e. the user is on /sessions/:id).
  // Commands that need session context (e.g. /compact) check this and toast if
  // it's missing rather than failing silently.
  sessionId?: string;
  posture: PermissionPosture;
  setPosture: (posture: PermissionPosture) => void;
};

export type Command = {
  name: string;
  description: string;
  value: string;
  action?: (ctx: CommandContext) => void | Promise<void>;
};
