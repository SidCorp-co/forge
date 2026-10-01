"use client";

import type { SelectHTMLAttributes } from "react";
import {
  Select as ShadcnSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

export interface SelectOption {
  value: string;
  label: string;
  icon?: IconName;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
  className?: string;
}

export function Select({
  options, value, onChange, placeholder = "Select…", disabled, id, invalid,
  className, ...aria
}: SelectProps) {
  const selected = options.find((o) => o.value === value);
  const isInvalid = invalid || (aria as Record<string, unknown>)["aria-invalid"] === true;
  return (
    <div className={cn("relative", className)}>
      <ShadcnSelect
        value={selected ? value : null}
        disabled={disabled}
        items={options.map((o) => ({ value: o.value, label: o.label }))}
        onValueChange={(next) => {
          if (typeof next === "string") onChange?.(next);
        }}
      >
        <SelectTrigger
          id={id}
          aria-label={aria["aria-label"]}
          aria-describedby={aria["aria-describedby"]}
          aria-invalid={isInvalid || undefined}
          className={cn(
            "h-auto! w-full gap-2 rounded-md bg-surface py-2 pl-3 pr-2.5 text-left text-sm transition-shadow",
            "focus-visible:ring-0 focus-visible:shadow-[var(--shadow-focus)]",
            isInvalid
              ? "border-[color:var(--red-500)] focus-visible:border-[color:var(--red-500)]"
              : "border-line-strong focus-visible:border-[color:var(--link)]",
          )}
        >
          {selected?.icon && <Icon name={selected.icon} size={16} className="text-subtle" />}
          <SelectValue className={cn("flex-1 truncate", selected ? "text-fg" : "text-disabled")}>
            {() => (selected ? selected.label : placeholder)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent
          align="start"
          alignItemWithTrigger={false}
          sideOffset={6}
          className="max-h-[min(256px,var(--available-height))] rounded-lg border border-line bg-surface p-1.5 shadow-lg ring-0"
        >
          {options.map((o) => (
            <SelectItem
              key={o.value}
              value={o.value}
              disabled={o.disabled}
              className="group gap-2.5 rounded-md px-2.5 py-2 pr-8 text-13-5 text-fg data-highlighted:bg-accent-tint data-highlighted:text-accent-text focus:bg-accent-tint focus:text-accent-text [&_[data-slot=select-item-indicator]]:text-accent"
            >
              {o.icon && <Icon name={o.icon} size={16} className="text-subtle group-data-highlighted:text-accent" />}
              <span className="flex-1 truncate">{o.label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </ShadcnSelect>
    </div>
  );
}

export interface NativeSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: SelectOption[];
}

/** Plain OS-native select, styled to match Input — preferred where the native
    mobile picker / minimal JS is wanted. */
export function NativeSelect({ options, className, ...props }: NativeSelectProps) {
  return (
    <div className="relative inline-flex w-full items-center">
      <select
        className={cn(
          "w-full appearance-none rounded-md border border-line-strong bg-surface py-2 pl-3 pr-9 text-sm text-fg",
          "transition-shadow focus-visible:border-[color:var(--link)] focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={16} className="pointer-events-none absolute right-3 text-subtle" />
    </div>
  );
}
