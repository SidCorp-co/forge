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
  /** Id for the headline, which also makes it programmatically focusable. */
  // cm:guard `tabIndex={-1}` rides WITH the id rather than being always-on: a heading in the tab order is a stop that does nothing for every keyboard user on every screen, and a screen that has to move focus here after a list empties needs it reachable by script only (ISS-998).
  titleId?: string;
}

/** Design-system empty state: mascot + one calm line + one way forward. */
export function EmptyState({ title, message, action, mascot = true, titleId }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3.5 px-6 py-12 text-center">
      {mascot && <ForgeMascot size={88} mode="blink" ring={false} progress={0.4} />}
      <div>
        {title && (
          <p
            id={titleId}
            tabIndex={titleId ? -1 : undefined}
            className="fg-h3 rounded-md focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            {title}
          </p>
        )}
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
