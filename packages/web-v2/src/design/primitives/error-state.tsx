import { Button } from "./button";
import { ForgeMascot } from "@/design/patterns/forge-mascot";

export interface ErrorStateProps {
  title?: string;
  /** Plain cause + remedy — never apologetic. */
  message: string;
  onRetry?: () => void;
}

/** Failure state — mascot (flame stilled) + one line + a retry. Never a dead end. */
export function ErrorState({ title = "Couldn't load", message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3.5 px-6 py-12 text-center">
      <ForgeMascot size={88} mode="blink" ring={false} flicker={false} progress={0.4} />
      <div>
        <p className="fg-h3">{title}</p>
        <p className="fg-body-sm mx-auto mt-1 max-w-[260px]">{message}</p>
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" icon="rerun" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
