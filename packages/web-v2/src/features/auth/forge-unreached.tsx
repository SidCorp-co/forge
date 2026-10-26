"use client";

import { ErrorState } from "@/design";
import { ApiError } from "@/lib/api/client";
import { formatApiError, readFailure } from "@/lib/api/error";

/** In place of a workspace whose account could not be read: why, and Retry — never Sign in (ISS-1228). */
export function ForgeUnreached({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-app px-4">
      <ErrorState
        level={1}
        title="Couldn't open Forge"
        message={formatApiError(error)}
        technical={error instanceof ApiError ? readFailure(error).technical : undefined}
        onRetry={onRetry}
      />
    </main>
  );
}
