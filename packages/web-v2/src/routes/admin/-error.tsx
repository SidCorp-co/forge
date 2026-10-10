import type { ErrorComponentProps } from "@tanstack/react-router";

import { useEffect } from "react";
import { ErrorState } from "@/design";
import { formatApiError } from "@/lib/api/error";

/** Boundary for throws from the section pages under app/admin/**; the gate's
 *  own failures never reach here — see OperatorLoadError in the gate. */
export function AdminError({ error, reset }: ErrorComponentProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex h-dvh items-center justify-center bg-app">
      <ErrorState message={formatApiError(error)} onRetry={reset} />
    </div>
  );
}
