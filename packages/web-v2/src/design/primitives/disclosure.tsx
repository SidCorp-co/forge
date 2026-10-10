
// A fold: its label, a count or one short summary, and a chevron; the body opens under it. Base UI's
// Collapsible gives the button, aria-expanded/controls and the open state (controlled or not).

import type { ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Icon } from "@/design/icons/icon";

export interface DisclosureProps {
  title: ReactNode;
  /** How many the fold holds, beside its title. */
  count?: number;
  /** One short line read while it is shut. */
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testId?: string;
  /** The `data-highlight` the chat's ui.highlight finds this fold by. */
  highlight?: string;
}

export function Disclosure({ title, count, summary, children, defaultOpen = false, open, onOpenChange, testId, highlight }: DisclosureProps) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
      className="group/fold border-t border-line-subtle first:border-t-0"
      data-testid={testId}
      data-highlight={highlight}
    >
      <CollapsibleTrigger className="flex h-row w-full min-w-0 items-center gap-3 text-left focus-visible:outline-none focus-visible:shadow-focus">
        <Icon name="chevronRight" size={16} className="flex-none text-subtle transition-transform duration-150 group-data-[open]/fold:rotate-90" />
        <span className="flex-none text-14 font-medium text-fg">
          {title}
          {count !== undefined ? <span className="ml-1.5 text-12 font-medium text-muted">{count}</span> : null}
        </span>
        {summary ? <span className="min-w-0 flex-1 truncate text-13 text-muted">{summary}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-4 pl-7">{children}</CollapsibleContent>
    </Collapsible>
  );
}
