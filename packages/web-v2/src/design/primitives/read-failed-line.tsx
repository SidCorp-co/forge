import { RetryButton } from "@/design/primitives/retry-button";
import { cn } from "@/lib/utils/cn";

/** A failed read where its list or choice would stand: what, why, and Retry where the one rule allows (ISS-1229 r48).
 *  The alert is the sentence alone: a wait counted beside Retry is never inside it, so it is not re-announced
 *  each second (r53, judge-165). */
export function ReadFailedLine({
  what,
  why,
  error,
  onRetry,
  testId,
  className,
}: {
  /** What could not be loaded, as the sentence names it: "the organization's members". */
  what: string;
  why: string;
  /** The failed read, which decides whether Retry is offered (ISS-1229 r50). */
  error: unknown;
  onRetry: () => void;
  testId?: string;
  className?: string;
}) {
  return (
    <div data-testid={testId} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", className)}>
      <p role="alert" className="fg-body-sm min-w-0 text-fg">
        Couldn&apos;t load {what}. <span className="text-muted">{why}</span>
      </p>
      <RetryButton error={error} onRetry={onRetry} />
    </div>
  );
}
