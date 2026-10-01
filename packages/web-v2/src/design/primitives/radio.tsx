"use client";

import type { ReactNode } from "react";
import { RadioGroup as ShadcnRadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils/cn";

export interface RadioGroupProps {
  value: string;
  onChange?: (v: string) => void;
  name: string;
  children: ReactNode;
  className?: string;
}

export function RadioGroup({ value, onChange, name, children, className }: RadioGroupProps) {
  return (
    <ShadcnRadioGroup
      name={name}
      value={value}
      onValueChange={(next) => onChange?.(next as string)}
      className={cn("flex flex-col gap-2.5", className)}
    >
      {children}
    </ShadcnRadioGroup>
  );
}

export interface RadioProps {
  value: string;
  label?: ReactNode;
  disabled?: boolean;
}

export function Radio({ value, label, disabled }: RadioProps) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2.5">
      <RadioGroupItem
        value={value}
        disabled={disabled}
        className={cn(
          "size-[18px] border-line-strong bg-surface hover:border-strong",
          "data-checked:border-accent data-checked:bg-surface",
          "focus-visible:ring-0 focus-visible:shadow-[var(--shadow-focus)]",
          "[&_[data-slot=radio-group-indicator]>span]:size-2.5 [&_[data-slot=radio-group-indicator]>span]:bg-accent",
        )}
      />
      {label && <span className="fg-body-sm text-fg">{label}</span>}
    </label>
  );
}
