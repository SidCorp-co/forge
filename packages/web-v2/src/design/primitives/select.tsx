import type { SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon } from "@/design/icons/icon";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: SelectOption[];
}

/** Native select, styled to match Input (keeps OS a11y / keyboard for free). */
export function Select({ options, className, ...props }: SelectProps) {
  return (
    <div className="relative inline-flex w-full items-center">
      <select
        className={cn(
          "w-full appearance-none rounded-md border border-line-strong bg-surface py-2 pl-3 pr-9 text-sm text-fg",
          "transition-shadow focus-visible:border-[color:var(--link)] focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none",
          className,
        )}
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={16} className="pointer-events-none absolute right-3 text-subtle" />
    </div>
  );
}
