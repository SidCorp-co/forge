"use client";

// The list page's two blocks under its header (the title, view switch and primary action live in the
// top bar through PageTitle and TopBarActions): the filter bar, and the page grid that sets a peek
// beside the list. The list itself is GroupedList for entities that stand somewhere, RowList for
// everything else.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/** The filter bar: search first, then filters and chips, a hairline under it. */
export function ListToolbar({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 max-md:px-3" data-testid={testId ?? "list-toolbar"}>
      {children}
    </div>
  );
}

/** A compact filter in the bar, as tall as the search beside it. */
export function ToolbarSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-7.5 rounded-sm border border-line bg-surface px-2 text-12-5 text-muted max-md:h-10">
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** The list and, while one is open, its peek beside it from 1024px (under it below). */
export function ListLayout({ children, peek, testId }: { children: ReactNode; peek?: ReactNode; testId?: string }) {
  return (
    <div className={cn("grid min-h-96 items-start", peek && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")} data-testid={testId}>
      <div className="min-w-0">{children}</div>
      {peek ?? null}
    </div>
  );
}
