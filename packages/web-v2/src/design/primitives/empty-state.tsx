import type { ReactNode } from "react";
import type { IconName } from "@/design/icons/icon";
import { Button } from "./button";
import { ForgeMascot } from "@/design/patterns/forge-mascot";
import { TabTitle } from "./tab-title";

interface EmptyStateBase {
  /** One calm line — never cute, never apologetic. */
  message: ReactNode;
  /** `icon` is drawn only where named: a plus says "add", and most ways forward add nothing. */
  action?: { label: string; onClick?: () => void; icon?: IconName };
  /** Lead with the mascot (default). Set false for dense inline spots. */
  mascot?: boolean;
  /** Id for the headline, which also makes it programmatically focusable. */
  titleId?: string;
}

/** A state that is the whole page is headed by its title, which names the tab too. */
export type EmptyStateProps = EmptyStateBase &
  ({ level: 1; title: string } | { level?: 2 | 3; title?: string });

/** Mascot + one calm line + one way forward; at level 1 the title heads the page and names the tab. */
export function EmptyState({ title, message, action, mascot = true, titleId, level = 2 }: EmptyStateProps) {
  const Heading = `h${level}` as const;
  return (
    <div className="flex flex-col items-center justify-center gap-3.5 px-6 py-12 text-center">
      {mascot && <ForgeMascot size={88} mode="blink" ring={false} progress={0.4} />}
      <div>
        {title && (
          <Heading
            id={titleId}
            tabIndex={titleId ? -1 : undefined}
            className="fg-h3 rounded-md focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            {title}
          </Heading>
        )}
        {title && level === 1 && <TabTitle subject={title} />}
        <p className="fg-body-sm mx-auto mt-1 max-w-[260px]">{message}</p>
      </div>
      {action && (
        <Button variant="primary" size="sm" icon={action.icon} onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
