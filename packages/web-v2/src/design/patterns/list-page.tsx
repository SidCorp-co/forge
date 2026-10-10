"use client";

// The list page's two blocks under its header (the title, view switch and primary action live in the
// top bar through PageTitle and TopBarActions): the filter bar, and the split that sets a peek beside
// the list. The list itself is GroupedList for entities that stand somewhere, RowList for the rest.

import type { ReactNode } from "react";
import { useMediaQuery } from "../hooks/use-media-query";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../primitives/resizable";
import { Select, type SelectOption } from "../primitives/select";

/** The filter bar: search first, then filters and chips, a hairline under it. */
export function ListToolbar({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2 max-md:px-3" data-testid={testId ?? "list-toolbar"}>
      {children}
    </div>
  );
}

/** A compact filter in the bar, as tall as the search beside it. */
export function ToolbarSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: SelectOption[] }) {
  return <Select aria-label={label} value={value} onChange={onChange} options={options} className="w-auto min-w-32" />;
}

/** The list and, while one is open, its peek: a draggable split from 1024px, the peek's own sheet below. */
export function ListLayout({ children, peek, testId }: { children: ReactNode; peek?: ReactNode; testId?: string }) {
  const wide = useMediaQuery("(min-width: 1024px)");
  if (!peek || !wide) {
    return (
      <div data-testid={testId}>
        {children}
        {peek ?? null}
      </div>
    );
  }
  return (
    <ResizablePanelGroup id="list-peek" orientation="horizontal" className="items-start" data-testid={testId}>
      <ResizablePanel id="list" minSize="40%">
        <div className="min-w-0">{children}</div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="peek" defaultSize="420px" minSize="340px" maxSize="50%">
        {peek}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
