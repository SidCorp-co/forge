
// A report's numbers: one flush row of cells, label above value, hairlines between them, never tiles.
// Charts sit in a Section under it.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { LEGEND, type LegendTone } from "../vocabulary";

/** `cellMin` is the narrowest a cell gets before the row wraps (px): a row of short counts fits more in one line. */
export function StatRow({ children, testId, cellMin = 140 }: { children: ReactNode; testId?: string; cellMin?: number }) {
  return (
    <div className="grid border-y border-line-subtle" style={{ gridTemplateColumns: `repeat(auto-fit,minmax(${cellMin}px,1fr))` }} data-testid={testId ?? "stat-row"}>
      {children}
    </div>
  );
}

/** With `href` the cell is a link to what it counts (an anchor on the page, or a filtered list). */
export function StatCell({ label, value, hint, tone, testId, href }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: LegendTone; testId?: string; href?: string | undefined }) {
  const cell = cn("min-w-0 border-line-subtle px-4 py-3 [&:not(:first-child)]:border-l max-sm:px-3", href && "block text-fg no-underline hover:bg-hover");
  const body = (
    <>
      <div className="text-12 font-medium text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-20 font-semibold tabular-nums" style={tone ? { color: LEGEND[tone].fg } : undefined}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 truncate text-12 text-subtle">{hint}</div> : null}
    </>
  );
  return href ? (
    <a href={href} className={cell} data-testid={testId ?? "stat-cell"}>
      {body}
    </a>
  ) : (
    <div className={cell} data-testid={testId ?? "stat-cell"}>
      {body}
    </div>
  );
}
