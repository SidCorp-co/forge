"use client";

import { createContext, useContext, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

interface RadioCtx {
  value: string;
  onChange?: (v: string) => void;
  name: string;
}
const Ctx = createContext<RadioCtx | null>(null);

export interface RadioGroupProps {
  value: string;
  onChange?: (v: string) => void;
  name: string;
  children: ReactNode;
  className?: string;
}

export function RadioGroup({ value, onChange, name, children, className }: RadioGroupProps) {
  return (
    <Ctx.Provider value={{ value, onChange, name }}>
      <div role="radiogroup" className={cn("flex flex-col gap-2.5", className)}>
        {children}
      </div>
    </Ctx.Provider>
  );
}

export interface RadioProps {
  value: string;
  label?: ReactNode;
  disabled?: boolean;
}

export function Radio({ value, label, disabled }: RadioProps) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("Radio must be used within <RadioGroup>");
  const checked = ctx.value === value;
  return (
    <label className="inline-flex cursor-pointer items-center gap-2.5">
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => ctx.onChange?.(value)}
        className={cn(
          "inline-flex size-[18px] flex-none items-center justify-center rounded-pill border transition-colors duration-[120ms]",
          "disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
          checked ? "border-accent" : "border-line-strong hover:border-strong",
        )}
      >
        {checked && <span className="size-2.5 rounded-pill bg-accent" />}
      </button>
      {label && <span className="fg-body-sm text-fg">{label}</span>}
    </label>
  );
}
