import { RetryButton } from "@/design/primitives/retry-button";
import { cn } from "@/lib/utils/cn";

/**
 * A reading kept on screen through a failed refresh: one line saying when it was read and why the
 * refresh failed, with Retry where the failed read's error allows one. The reading itself stays where it
 * was (ISS-1228 r26).
 */
export function StaleReadLine({
  said,
  error,
  onRetry,
  className,
}: {
  said: string;
  error: unknown;
  onRetry?: (() => void) | undefined;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <p role="status" className="fg-caption fg-caption-stale">
        {said}
      </p>
      <RetryButton error={error} onRetry={onRetry} />
    </div>
  );
}
