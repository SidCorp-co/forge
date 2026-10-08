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
  /**
   * Seat every count in a slot of one width, so the bar is as wide for `0` as for `1399` and the
   * controls beside it keep their rows when a filter changes the figures. A count above
   * `STABLE_COUNT_CAP` reads `STABLE_COUNT_CAP+` and carries its full figure on the tab's title.
   */
  stableCountWidth?: boolean;
}

/** The largest figure the stable slot spells out: four digits, the same five characters as `9999+`. */
export const STABLE_COUNT_CAP = 9999;

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  stableCountWidth = false,
}: SegmentedControlProps<T>) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-line bg-sunken p-0.5">
      {options.map((opt) => {
        const active = opt.value === value;
        const capped = stableCountWidth && opt.count !== undefined && opt.count > STABLE_COUNT_CAP;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={opt.disabled}
            title={opt.title ?? (capped ? String(opt.count) : undefined)}
            onClick={() => !opt.disabled && onChange?.(opt.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-13 font-semibold transition-colors duration-[120ms]",
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
                  "ml-0.5 rounded-full px-1.5 py-px text-11 font-semibold tabular-nums",
                  stableCountWidth && "box-content inline-block w-[5ch] text-center",
                  opt.count === 0
                    ? "bg-sunken text-muted"
                    : opt.countTone === "attention"
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                      : "bg-sunken text-muted",
                )}
              >
                {capped ? `${STABLE_COUNT_CAP}+` : opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
