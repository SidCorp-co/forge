"use client";

// A report's numbers: one flush row of cells, label above value, hairlines between them, never tiles.
// Charts sit in a Section under it.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { LEGEND, type LegendTone } from "../vocabulary";

export function StatRow({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] border-y border-line-subtle" data-testid={testId ?? "stat-row"}>
      {children}
    </div>
  );
}

export function StatCell({ label, value, hint, tone, testId }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: LegendTone; testId?: string }) {
  return (
    <div className={cn("min-w-0 border-line-subtle px-4 py-3 [&:not(:first-child)]:border-l max-sm:px-3")} data-testid={testId ?? "stat-cell"}>
      <div className="text-12 font-medium text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-20 font-semibold tabular-nums" style={tone ? { color: LEGEND[tone].fg } : undefined}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 truncate text-12 text-subtle">{hint}</div> : null}
    </div>
  );
}
