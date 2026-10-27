import { useRetryWait } from "@/design/hooks/use-retry-wait";
import { isRetryableApiError } from "@/lib/utils/retry-rule";
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
 * The one Retry for a failed read, as a word inside a sentence. Like `RetryButton` it draws nothing where a
 * second read cannot change the answer (ISS-1229 r50), and where the server named a wait it says how long is
 * left in its place (r51). It imports nothing heavier than the rule, so a design pattern that carries it stays
 * buildable on its own.
 */
export function RetryLink({
  error,
  onRetry,
  label,
  title,
  testId,
  className,
  disabled,
  children,
  onKeyDown,
}: {
  error: unknown;
  onRetry: (() => void) | undefined;
  /** The accessible name where the visible word alone would not say what is read again. */
  label?: string | undefined;
  title?: string | undefined;
  testId?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  /** The visible words, where they are not plain "Retry". */
  children?: React.ReactNode;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement> | undefined;
}) {
  const wait = useRetryWait(onRetry ? error : null);
  if (!onRetry || !isRetryableApiError(error)) return null;
  if (wait) return <RetryWait wait={wait} testId={testId} />;
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      data-testid={testId}
      disabled={disabled}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        e.stopPropagation();
        onRetry();
      }}
      className={cn("text-link hover:underline", className)}
    >
      {children ?? "Retry"}
    </button>
  );
}
