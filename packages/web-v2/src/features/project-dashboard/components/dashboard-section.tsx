// A dashboard section, flat: a title over a hairline and its rows under it, no box around it.
// A section that holds nothing is one `EmptyPanelLine` (ISS-1150) with its card chrome taken off
// through `className`, so the primitive stays as written and the page stays flush.

import type { ReactNode } from "react";
import { EmptyPanelLine } from "@/design";
import { cn } from "@/lib/utils/cn";

export interface DashboardSectionProps {
  title: string;
  /** Right of the title: a figure or a comparison, in the caption voice. */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function DashboardSection({ title, aside, children, className }: DashboardSectionProps) {
  return (
    <section aria-label={title} className={cn("min-w-0 border-t border-line pt-3", className)}>
      <header className="mb-1.5 flex items-baseline justify-between gap-3">
        <h2 className="fg-label">{title}</h2>
        {aside != null && <span className="fg-caption min-w-0 text-right text-subtle">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

export interface EmptyLineProps {
  title: string;
  status: string;
  detail?: string;
  action?: ReactNode;
}

/** The empty form of a section: one line, flat, with a hairline above in place of the card's border. */
export function EmptyLine({ title, status, detail, action }: EmptyLineProps) {
  return (
    <EmptyPanelLine
      title={title}
      status={status}
      detail={detail}
      action={action}
      className="rounded-none border-0 border-t border-line bg-transparent px-0 shadow-none"
    />
  );
}

/** A flush list: rows divided by hairlines, never boxed. */
export function RowList({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cn("flex flex-col divide-y divide-line-subtle", className)}>{children}</ul>;
}

/** The two figures that have no data yet. ISS-380 owns them and their removal; this is the one line that says so. */
export function ComingSoonNote() {
  return (
    <p className="fg-caption text-subtle">
      Not yet measured: pass rate (7d) and cost over time · coming soon (ISS-380)
    </p>
  );
}
