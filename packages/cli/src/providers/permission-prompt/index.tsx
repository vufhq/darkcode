import { useEffect, useRef, type ReactNode } from "react";
import { useDialog } from "../dialog";
import { registerPermissionPrompt } from "../../lib/permissions/engine";
import { PermissionDialogContent } from "../../components/dialogs/permission-dialog";
import type { PermissionRequest, UserResponse } from "../../lib/permissions/types";

type Props = {
  children: ReactNode;
};

// Bridges the permission engine to the dialog system. At mount time we
// register a handler so the engine (a plain async function) can ask the
// React tree for a decision. The handler returns a Promise that resolves
// when the user clicks a choice (or denies on escape).
export function PermissionPromptProvider({ children }: Props) {
  const dialog = useDialog();
  // Capture the latest dialog ref so the handler isn't stale-closured if
  // the dialog identity changes between renders.
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;

  useEffect(() => {
    const unregister = registerPermissionPrompt((request: PermissionRequest) => {
      return new Promise<UserResponse>((resolve) => {
        let resolved = false;
        const settle = (response: UserResponse) => {
          if (resolved) return;
          resolved = true;
          resolve(response);
        };

        dialogRef.current.open({
          title: "Permission required",
          children: (
            <PermissionDialogContent
              request={request}
              onResolve={settle}
            />
          ),
          // If the user dismisses the dialog (escape / click-out) without
          // choosing, treat as deny — never default-allow.
          onClose: () => settle({ decision: "deny" }),
        });
      });
    });

    return unregister;
  }, []);

  return <>{children}</>;
}
