"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { LEGEND, type LegendTone } from "../vocabulary";

export interface FilterChipProps {
  on: boolean;
  onToggle: () => void;
  count: number;
  children: ReactNode;
  /** The count wears this tone while it is above zero ("Waiting on you" amber). */
  tone?: LegendTone;
  testId?: string;
}

/** A toggle filter beside a list's search: its label, its count, pressed while it narrows the list. */
export function FilterChip({ on, onToggle, count, children, tone, testId }: FilterChipProps) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      data-testid={testId ?? "filter-chip"}
      className={cn(
        "inline-flex h-[30px] items-center gap-1.5 rounded-pill border px-2.5 text-12-5 font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] max-md:h-9",
        on ? "border-fg bg-fg text-surface" : "border-line bg-surface text-muted hover:text-fg",
      )}
    >
      {children}
      <span className="font-mono text-12" style={!on && tone && count > 0 ? { color: LEGEND[tone].fg } : undefined}>
        {count}
      </span>
    </button>
  );
}
