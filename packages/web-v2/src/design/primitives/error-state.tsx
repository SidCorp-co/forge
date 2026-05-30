import { Icon } from "@/design/icons/icon";
import { Button } from "./button";

export interface ErrorStateProps {
  /** Plain cause + remedy — never apologetic. */
  message: string;
  onRetry?: () => void;
}

/** Failure placeholder — mirror of EmptyState. One line + a retry. */
export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <Icon name="alert" size={22} style={{ color: "var(--red-500)" }} />
      <p className="fg-body-sm max-w-sm">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" icon="rerun" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
