"use client";

// A Details row: its label, one short summary, and a chevron; the body opens under it. The
// developer view opens every row the page folds, so a person's view and a developer's are the same rows.

import { type ReactNode, useId } from "react";
import { cn } from "@/lib/utils/cn";

export function FoldRow({
  label,
  summary,
  open,
  onToggle,
  children,
  testId,
  highlight,
}: {
  label: string;
  summary?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  testId?: string;
  /** The `data-highlight` the chat's ui.highlight finds this row by. */
  highlight?: string;
}) {
  const bodyId = useId();
  return (
    <div className="border-t border-line-subtle first:border-t-0" data-testid={testId} data-highlight={highlight}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full min-w-0 items-baseline gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        <span className="w-[120px] flex-none text-14 font-medium text-fg max-md:w-24">{label}</span>
        <span className="min-w-0 flex-1 truncate text-13 text-muted">{summary}</span>
        <span aria-hidden className={cn("flex-none text-subtle transition-transform", open && "rotate-90")}>
          ›
        </span>
      </button>
      <div id={bodyId} hidden={!open} className="pb-4 pl-[132px] max-md:pl-0">
        {open ? children : null}
      </div>
    </div>
  );
}
