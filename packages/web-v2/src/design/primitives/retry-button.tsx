import { isRetryableApiError } from "@/lib/utils/retry-rule";
import { Button } from "@/design/primitives/button";
import { RetryLink } from "@/design/primitives/retry-link";

/** Whether Retry is offered for this failed read: the web app's one rule (ISS-1229 r50, criterion 478). */
export function offersRetryFor(error: unknown): boolean {
  return isRetryableApiError(error);
}

/**
 * The one Retry for a failed read. It draws nothing where a second read cannot change the answer, so no
 * screen decides that for itself (ISS-1229 r50, judge-152: most screens offered Retry on a 403, 404 or 422).
 */
export function RetryButton({
  error,
  onRetry,
  look = "button",
  variant = "secondary",
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
  /** A secondary button, or a link-styled word inside a sentence. */
  look?: "button" | "link";
  /** The button's weight, where it is a button: secondary, or ghost inside a banner's action. */
  variant?: "secondary" | "ghost";
  /** The accessible name where the visible word alone would not say what is read again. */
  label?: string;
  title?: string;
  testId?: string;
  className?: string;
  disabled?: boolean;
  /** The visible words, where they are not plain "Retry". */
  children?: React.ReactNode;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
}) {
  if (look === "link") {
    return (
      <RetryLink
        error={error}
        onRetry={onRetry}
        label={label}
        title={title}
        testId={testId}
        className={className}
        disabled={disabled}
        onKeyDown={onKeyDown}
      >
        {children}
      </RetryLink>
    );
  }
  if (!onRetry || !offersRetryFor(error)) return null;
  const text = children ?? "Retry";
  return (
    <Button
      variant={variant}
      size="sm"
      icon={variant === "ghost" ? undefined : "rerun"}
      aria-label={label}
      title={title}
      data-testid={testId}
      disabled={disabled}
      className={className}
      onClick={onRetry}
    >
      {text}
    </Button>
  );
}
