"use client";

import { ErrorState } from "@/design";
import { ApiError } from "@/lib/api/client";
import { formatApiError, readFailure } from "@/lib/api/error";

/** The page in place of a workspace whose account could not be read: why, and Retry — never Sign in,
 *  which Forge has not said (ISS-1228). A server's answer is kept under Technical details; a request
 *  that never reached Forge has none, and the browser's own words are not shown. */
export function ForgeUnreached({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-app px-4">
      <ErrorState
        title="Couldn't open Forge"
        message={formatApiError(error)}
        technical={error instanceof ApiError ? readFailure(error).technical : undefined}
        onRetry={onRetry}
      />
    </main>
  );
}
