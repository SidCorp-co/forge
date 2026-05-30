import { Button } from "./button";
import { ForgeMascot } from "@/design/patterns/forge-mascot";

export interface EmptyStateProps {
  /** Short headline, e.g. "No issues yet". */
  title?: string;
  /** One calm line — never cute, never apologetic. */
  message: string;
  action?: { label: string; onClick?: () => void };
  /** Lead with the mascot (default). Set false for dense inline spots. */
  mascot?: boolean;
}

/** Design-system empty state: mascot + one calm line + one way forward. */
export function EmptyState({ title, message, action, mascot = true }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3.5 px-6 py-12 text-center">
      {mascot && <ForgeMascot size={88} mode="blink" ring={false} progress={0.4} />}
      <div>
        {title && <p className="fg-h3">{title}</p>}
        <p className="fg-body-sm mx-auto mt-1 max-w-[260px]">{message}</p>
      </div>
      {action && (
        <Button variant="primary" size="sm" icon="plus" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
