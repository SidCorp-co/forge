// A fold whose body opens in a side drawer, never under it (REQ-43 r3 BC-17, owner 2026-11-10): the
// Disclosure's one line, its label, a count or one short summary, and a chevron, so a record page reads
// the same shut; a click opens the body in the shared SlideOver and the page under it never grows.
// The body is not drawn while it is shut.

import { type ReactNode, useState } from "react";
import { Icon } from "../icons/icon";
import { SlideOver } from "./slide-over";

interface DrawerFoldProps {
  title: ReactNode;
  /** How many the fold holds, beside its title. */
  count?: number;
  /** The word the count is of ("open"), read with it: "2 open". */
  countUnit?: string;
  /** One short line read while it is shut. */
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testId?: string;
  /** The `data-highlight` the chat's ui.highlight finds this fold by. */
  highlight?: string;
  /** A few words the fold's line says on hover. */
  hint?: string;
  width?: number;
}

export function DrawerFold({ title, count, countUnit, summary, children, defaultOpen = false, open, onOpenChange, testId, highlight, hint, width = 560 }: DrawerFoldProps) {
  const [own, setOwn] = useState(defaultOpen);
  const shown = open ?? own;
  const set = (next: boolean) => {
    setOwn(next);
    onOpenChange?.(next);
  };
  const counted = count !== undefined ? <span className="ml-1.5 text-12 font-medium text-muted">{countUnit ? `${count} ${countUnit}` : count}</span> : null;
  return (
    <div className="border-t border-line-divider first:border-t-0" data-testid={testId} data-count={count} data-highlight={highlight}>
      <button
        type="button"
        title={hint}
        aria-haspopup="dialog"
        aria-expanded={shown}
        onClick={() => set(true)}
        className="flex h-row w-full min-w-0 items-center gap-3 text-left hover:bg-hover focus-visible:outline-none focus-visible:shadow-focus"
      >
        <Icon name="chevronRight" size={16} className="flex-none text-subtle" />
        <span className="flex-none text-14 font-medium text-fg">
          {title}
          {counted}
        </span>
        {/* width 0, then grown: a one-line summary is cut to the row, never widens the page it sits in */}
        {summary ? <span className="w-0 min-w-0 flex-1 truncate text-13 text-muted">{summary}</span> : null}
      </button>
      <SlideOver
        open={shown}
        onClose={() => set(false)}
        width={width}
        title={
          <>
            {title}
            {counted}
          </>
        }
      >
        {shown ? children : null}
      </SlideOver>
    </div>
  );
}
