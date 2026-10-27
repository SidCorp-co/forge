"use client";

import { useRetryWait } from "@/design/hooks/use-retry-wait";
import { cn } from "@/lib/utils/cn";

/** Where a Retry waits on the server's word: how long is left, in its place until the wait is over (ISS-1229 r51). */
export function RetryWait({ wait, testId, className }: { wait: string; testId?: string | undefined; className?: string | undefined }) {
  return (
    <span data-testid={testId ? `${testId}-wait` : "retry-wait"} className={cn("fg-caption text-muted", className)}>
      {wait}
    </span>
  );
}

/**
 * A Retry while the server's wait runs: the wait, counted down, in its place; the Retry itself once it is over.
 * A client part of its own, so the one Retry stays a component any page can render (ISS-1229 r51).
 */
export function RetryWaitGate({
  error,
  testId,
  className,
  children,
}: {
  error: unknown;
  testId?: string | undefined;
  className?: string | undefined;
  children: React.ReactNode;
}) {
  const wait = useRetryWait(error);
  return wait ? <RetryWait wait={wait} testId={testId} className={className} /> : children;
}
