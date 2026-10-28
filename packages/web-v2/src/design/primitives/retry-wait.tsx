"use client";

import { useRetryWait, useWaitAnnounced } from "@/design/hooks/use-retry-wait";
import { cn } from "@/lib/utils/cn";

/** Where a Retry waits on the server's word: how long is left, in its place until the wait is over (ISS-1229 r51).
 *  A timer, which a screen reader reads when asked and never announces as it counts (r53, judge-165). */
export function RetryWait({ wait, testId, className }: { wait: string; testId?: string | undefined; className?: string | undefined }) {
  return (
    <span role="timer" data-testid={testId ? `${testId}-wait` : "retry-wait"} className={cn("fg-caption text-muted", className)}>
      {wait}
    </span>
  );
}

/**
 * A Retry while the server's wait runs: the wait, counted down, in its place; the Retry itself once it is over.
 * The wait's start and its end are told once for the read, wherever it is shown, never a tick (r53, r54). A client
 * part of its own, so the one Retry stays a component any page can render (ISS-1229 r51).
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
  useWaitAnnounced(error);
  return wait ? <RetryWait wait={wait} testId={testId} className={className} /> : children;
}
