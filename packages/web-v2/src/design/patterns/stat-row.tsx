
// A report's numbers: one flush row of cells, label above value, hairlines between them, never tiles.
// Charts sit in a Section under it.

import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { LEGEND, type LegendTone } from "../vocabulary";

/** The narrowest track of a row of `n` cells: all `n` on one line where each gets `cellMin`, else two
 *  even lines (`ceil(n/2)` a line), else two a line. Never a line of four over a line of one. */
export function statTrack(n: number, cellMin: number): string {
  const one = `calc((100% - 1px) / ${Math.max(n, 1)})`;
  const half = Math.max(Math.ceil(n / 2), 1);
  const two = `calc((100% - 1px) / ${half})`;
  const pairs = "calc((100% - 1px) / 2)";
  const inner = `clamp(${two}, (${half * cellMin}px - 100%) * 999, ${pairs})`;
  return `clamp(${one}, (${n * cellMin}px - 100%) * 999, ${inner})`;
}

/** `cellMin` is the narrowest a cell gets before the row wraps (px). Given `cells` (how many it holds)
 *  the row wraps into even lines; without it, into as many as fit. It stretches with its column, and
 *  hairlines sit between cells and between lines, never at the row's edge. */
export function StatRow({ children, testId, cellMin = 140, cells }: { children: ReactNode; testId?: string; cellMin?: number; cells?: number }) {
  const track = cells ? statTrack(cells, cellMin) : `${cellMin}px`;
  return (
    <div className="overflow-hidden border-t border-line-subtle" data-testid={testId ?? "stat-row"} style={{ "--stat-track": track } as CSSProperties}>
      <div className="-ml-px grid [grid-template-columns:repeat(auto-fit,minmax(var(--stat-track),1fr))]">{children}</div>
    </div>
  );
}

/** With `href` the cell is a link to what it counts (an anchor on the page, or a filtered list). */
export function StatCell({ label, value, hint, tone, testId, href }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: LegendTone; testId?: string; href?: string | undefined }) {
  const cell = cn("min-w-0 border-b border-l border-line-subtle px-4 py-3 max-sm:px-3", href && "block text-fg no-underline hover:bg-hover");
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
