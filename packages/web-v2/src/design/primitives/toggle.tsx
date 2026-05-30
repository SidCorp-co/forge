"use client";

import { cn } from "@/lib/utils/cn";

export interface ToggleProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}

export function Toggle({ checked, onChange, disabled, ...rest }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] flex-none items-center rounded-pill border transition-colors duration-[120ms]",
        "disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none",
        checked
          ? "border-transparent bg-accent focus-visible:shadow-[var(--shadow-focus-accent)]"
          : "border-line-strong bg-sunken",
      )}
      {...rest}
    >
      <span
        className="inline-block size-[16px] rounded-pill bg-surface shadow-xs transition-transform duration-[120ms]"
        style={{ transform: checked ? "translateX(18px)" : "translateX(3px)" }}
      />
    </button>
  );
}
