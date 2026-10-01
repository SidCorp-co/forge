"use client";

import type { ReactNode } from "react";
import { Checkbox as ShadcnCheckbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils/cn";

export interface CheckboxProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  id?: string;
  indeterminate?: boolean;
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
  const box = (
    <ShadcnCheckbox
      id={id}
      checked={checked}
      indeterminate={indeterminate}
      disabled={disabled}
      aria-label={ariaLabel}
      onCheckedChange={(next) => onChange?.(next)}
      className={cn(
        "size-[18px] rounded-sm border-line-strong bg-surface hover:border-strong",
        "data-checked:border-transparent data-checked:bg-accent data-checked:text-on-accent",
        "data-indeterminate:border-transparent data-indeterminate:bg-accent data-indeterminate:text-on-accent",
        "focus-visible:ring-0 focus-visible:shadow-[var(--shadow-focus-accent)]",
      )}
    />
  );
  if (!label) return box;
  return (
    <label className="inline-flex cursor-pointer items-center gap-2.5">
      {box}
      <span className="fg-body-sm text-fg">{label}</span>
    </label>
  );
}
