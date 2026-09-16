"use client";

import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

export interface SegmentOption<T extends string> {
  value: T;
  label?: string;
  icon?: IconName;
  /** Render this option dimmed + non-selectable (e.g. "Auto" on a no-skill stage). */
  disabled?: boolean;
  /** Native title tooltip explaining why it's disabled. */
  title?: string;
  /** A figure rendered after the label. Omitted rather than zeroed when unknown — a count that is still loading must not read as an empty bucket. */
  count?: number;
  /** Paint the count as something that wants attention rather than as a neutral total. */
  countTone?: "neutral" | "attention";
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange?: (value: T) => void;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-line bg-sunken p-0.5">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={opt.disabled}
            title={opt.title}
            onClick={() => !opt.disabled && onChange?.(opt.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-[13px] font-semibold transition-colors duration-[120ms]",
              "focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none",
              opt.disabled
                ? "cursor-not-allowed text-muted opacity-50"
                : active
                  ? "bg-surface text-fg shadow-xs"
                  : "text-muted hover:text-fg",
            )}
          >
            {opt.icon && <Icon name={opt.icon} size={15} />}
            {opt.label}
            {opt.count !== undefined && (
              <span
                className={cn(
                  "ml-0.5 rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums",
                  opt.count === 0
                    ? "bg-sunken text-muted"
                    : opt.countTone === "attention"
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                      : "bg-sunken text-muted",
                )}
              >
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
