"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

export interface SegmentOption<T extends string> {
  value: T;
  label?: string;
  icon?: IconName;
  disabled?: boolean;
  title?: string;
  count?: number;
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
    <ToggleGroup
      spacing={0.5}
      value={[value]}
      onValueChange={(next) => {
        const picked = next[0] as T | undefined;
        if (picked !== undefined && picked !== value) onChange?.(picked);
      }}
      className="inline-flex items-center rounded-md border border-line bg-sunken p-0.5"
    >
      {options.map((opt) => (
        <ToggleGroupItem
          key={opt.value}
          value={opt.value}
          disabled={opt.disabled}
          title={opt.title}
          className={cn(
            "h-auto min-w-0 gap-1.5 rounded-sm px-2.5 py-1 text-13 font-semibold text-muted transition-colors duration-[120ms]",
            "hover:bg-transparent hover:text-fg focus-visible:ring-0 focus-visible:shadow-[var(--shadow-focus)]",
            "data-pressed:bg-surface data-pressed:text-fg data-pressed:shadow-xs aria-pressed:bg-surface",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {opt.icon && <Icon name={opt.icon} size={15} />}
          {opt.label}
          {opt.count !== undefined && (
            <span
              className={cn(
                "ml-0.5 rounded-full px-1.5 py-px text-11 font-semibold tabular-nums",
                opt.count === 0
                  ? "bg-sunken text-muted"
                  : opt.countTone === "attention"
                    ? "bg-amber-100 text-amber-800"
                    : "bg-sunken text-muted",
              )}
            >
              {opt.count}
            </span>
          )}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
