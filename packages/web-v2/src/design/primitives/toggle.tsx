"use client";

import { Switch } from "@/components/ui/switch";

export interface ToggleProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}

export function Toggle({ checked, onChange, disabled, ...rest }: ToggleProps) {
  return (
    <Switch
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next) => onChange?.(next)}
      className="h-[22px]! w-[38px]! flex-none border-line-strong px-[2px] data-checked:border-transparent data-checked:bg-accent data-unchecked:bg-sunken focus-visible:ring-0 focus-visible:shadow-[var(--shadow-focus-accent)] [&>[data-slot=switch-thumb]]:size-4! [&>[data-slot=switch-thumb]]:bg-surface [&>[data-slot=switch-thumb]]:shadow-xs [&>[data-slot=switch-thumb][data-checked]]:translate-x-4!"
      {...rest}
    />
  );
}
