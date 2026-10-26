import { Button, ButtonLink } from "./button";
import { ForgeMascot } from "@/design/patterns/forge-mascot";

export interface ErrorStateProps {
  title?: string;
  /** Plain cause + remedy — never apologetic. */
  message: string;
  onRetry?: () => void;
  /** A page to go on to, where trying again cannot change the answer. */
  action?: { label: string; href: string };
  /** Lead with the mascot (default). Set false for dense inline spots. */
  mascot?: boolean;
  /** The server's own code and message, for whoever reports it: folded under Technical details. */
  technical?: string;
}

/** Failure state — mascot (flame stilled) + one line + a retry. Never a dead end. */
export function ErrorState({ title = "Couldn't load", message, onRetry, action, mascot = true, technical }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3.5 px-6 py-12 text-center">
      {mascot && <ForgeMascot size={88} mode="blink" ring={false} flicker={false} progress={0.4} />}
      <div>
        <p className="fg-h3">{title}</p>
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
      {onRetry && (
        <Button variant="secondary" size="sm" icon="rerun" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
