import { Button } from "./button";

export interface EmptyStateProps {
  /** One calm line — never cute, never apologetic. */
  message: string;
  action?: { label: string; onClick?: () => void };
}

/** Design system empty-state: one calm line + one action. */
export function EmptyState({ message, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <p className="fg-body-sm max-w-sm">{message}</p>
      {action && (
        <Button variant="primary" size="sm" icon="plus" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
