import { useEffect, useState } from "react";

import { checkForUpdate, type UpdateStatus } from "../lib/update-check";

/**
 * Resolves the running version and whether a newer release exists.
 *
 * Starts as null so the UI renders nothing until we know — the version line
 * appears once, fully formed, instead of flickering from "v1.2.3" to
 * "v1.2.3 → update available".
 */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let active = true;
    // `checkForUpdate` never rejects, so there's no failure branch to handle:
    // an unknown latest version simply renders as the plain version line.
    checkForUpdate().then((result) => {
      if (active) setStatus(result);
    });
    return () => {
      active = false;
    };
  }, []);

  return status;
}
