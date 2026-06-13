"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon } from "@/design/icons/icon";

export interface CheckboxProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  id?: string;
  /** Tri-state: render a "partial" dash and `aria-checked="mixed"` (e.g. a
   *  select-all that covers some-but-not-all rows). `checked` still drives what
   *  `onChange` toggles to. */
  indeterminate?: boolean;
  /** Accessible name when there is no visible `label` (icon-only checkbox in a
   *  table cell). */
  ariaLabel?: string;
}

export function Checkbox({
  checked,
  onChange,
  disabled,
  label,
  id,
  indeterminate = false,
  ariaLabel,
}: CheckboxProps) {
  const filled = checked || indeterminate;
  const box = (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={ariaLabel}
      disabled={disabled}
      id={id}
      onClick={() => onChange?.(!checked)}
      className={cn(
        "inline-flex size-[18px] flex-none items-center justify-center rounded-sm border transition-colors duration-[120ms]",
        "disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none",
        filled
          ? "border-transparent bg-accent text-on-accent focus-visible:shadow-[var(--shadow-focus-accent)]"
          : "border-line-strong bg-surface hover:border-strong",
      )}
    >
      {checked ? (
        <Icon name="check" size={13} strokeWidth={3} />
      ) : indeterminate ? (
        <span className="h-0.5 w-2.5 rounded-full bg-on-accent" />
      ) : null}
    </button>
  );
  if (!label) return box;
  return (
    <label className="inline-flex cursor-pointer items-center gap-2.5">
      {box}
      <span className="fg-body-sm text-fg">{label}</span>
    </label>
  );
}
