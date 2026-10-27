import { ButtonLink } from "./button";
import { RetryButton } from "./retry-button";
import { ForgeMascot } from "@/design/patterns/forge-mascot";
import { TabTitle } from "./tab-title";

interface ErrorStateBase {
  /** Plain cause + remedy — never apologetic. */
  message: string;
  /** A page to go on to, where trying again cannot change the answer. */
  action?: { label: string; href: string };
  /** Lead with the mascot (default). Set false for dense inline spots. */
  mascot?: boolean;
  /** The server's own code and message, for whoever reports it: folded under Technical details. */
  technical?: string;
}

/** A failed read hands over its error with its Retry; an answer no read changes is `final` (ISS-1229 r50). */
export type ErrorStateRetry =
  | { error: unknown; onRetry: () => void; final?: never }
  | { final: true; onRetry?: never; error?: never };

export type ErrorStateProps = ErrorStateBase &
  ErrorStateRetry & {
    title: string;
    level?: 1 | 2 | 3;
  };

/** Failure state — mascot (flame stilled), a heading at `level` (1 where it is the whole page, naming the tab too), a retry. */
export function ErrorState({ title, message, onRetry, error, action, mascot = true, technical, level = 2 }: ErrorStateProps) {
  const Heading = `h${level}` as const;
  return (
    <div className="flex flex-col items-center justify-center gap-3.5 px-6 py-12 text-center">
      {mascot && <ForgeMascot size={88} mode="blink" ring={false} flicker={false} progress={0.4} />}
      <div>
        <Heading className="fg-h3">{title}</Heading>
        {level === 1 && <TabTitle subject={title} />}
        <p className="fg-body-sm mx-auto mt-1 max-w-[260px]">{message}</p>
      </div>
      {technical && (
        <details className="fg-caption max-w-full text-muted">
          <summary className="cursor-pointer">Technical details</summary>
          <p className="mt-1 break-words font-mono [overflow-wrap:anywhere]">{technical}</p>
        </details>
      )}
      {action && (
        <ButtonLink href={action.href} variant="secondary" size="sm">
          {action.label}
        </ButtonLink>
      )}
      <RetryButton error={error} onRetry={onRetry} />
    </div>
  );
}
