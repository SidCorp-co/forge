"use client";

import type { SegmentOption } from "@/design";
import { cn } from "@/lib/utils/cn";

/** One choice among a few, as a row of small pressable chips, each with its count. */
export function FilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset aria-label={label} className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 text-12-5 font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] max-sm:min-h-9",
              on ? "border-fg bg-fg text-surface" : "border-line bg-surface text-muted hover:text-fg",
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span
                className={cn(
                  "tabular-nums",
                  on ? "opacity-80" : o.countTone === "attention" && o.count > 0 ? "text-accent-text" : "text-subtle",
                )}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </fieldset>
  );
}
