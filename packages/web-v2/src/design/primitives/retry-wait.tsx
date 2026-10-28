"use client";

import { useRetryWait, useWaitAnnounced } from "@/design/hooks/use-retry-wait";
import { cn } from "@/lib/utils/cn";

/** How long is left before Retry, as a timer a screen reader reads when asked, never as it counts (ISS-1229 r53). */
export function RetryWait({ wait, testId, className }: { wait: string; testId?: string | undefined; className?: string | undefined }) {
  return (
    <span role="timer" data-testid={testId ? `${testId}-wait` : "retry-wait"} className={cn("fg-caption text-muted", className)}>
      {wait}
    </span>
  );
}

/** The wait counted in Retry's place until it is over; its start and end are told once per read (ISS-1229 r54). */
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
