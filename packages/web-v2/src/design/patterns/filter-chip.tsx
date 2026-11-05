
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { LEGEND, type LegendTone } from "../vocabulary";

interface FilterChipProps {
  on: boolean;
  onToggle: () => void;
  /** `null` while the list is still reading this group: the chip says so ("…") rather than a 0 nobody counted. */
  count: number | null;
  children: ReactNode;
  /** The count wears this tone while it is above zero ("Waiting on you" amber). */
  tone?: LegendTone;
  /** While not pressed and above zero, the whole chip wears its tone, not only its count: a group that needs the person. */
  fill?: boolean;
  testId?: string;
}

/** A toggle filter beside a list's search: its label, its count, pressed while it narrows the list. */
export function FilterChip({ on, onToggle, count, children, tone, fill = false, testId }: FilterChipProps) {
  const lit = count === null || count > 0;
  const filled = fill && !on && tone && lit ? LEGEND[tone] : null;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      data-testid={testId ?? "filter-chip"}
      style={filled ? { borderColor: filled.dot, background: filled.bg, color: filled.fg } : undefined}
      className={cn(
        "inline-flex h-[30px] items-center gap-1.5 rounded-pill border px-2.5 text-12-5 font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-focus max-md:h-9",
        on ? "border-fg bg-fg text-surface" : "border-line bg-surface text-muted hover:text-fg",
      )}
    >
      {children}
      <span className="font-mono text-12" style={!on && tone && lit ? { color: LEGEND[tone].fg } : undefined}>
        {count ?? "…"}
      </span>
    </button>
  );
}
