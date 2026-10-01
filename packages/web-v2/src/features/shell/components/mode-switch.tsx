"use client";

import { Icon, type IconName } from "@/design";
import { cn } from "@/lib/utils/cn";
import type { ShellMode } from "../mode";

const MODES: Array<{ value: ShellMode; label: string; icon: IconName }> = [
  { value: "activity", label: "Activity", icon: "activity" },
  { value: "chat", label: "Chat", icon: "chat" },
];

export function ModeSwitch({
  mode,
  onSwitch,
  compact = false,
}: {
  mode: ShellMode;
  onSwitch: (to: ShellMode) => void;
  compact?: boolean;
}) {
  return (
    <div
      role="tablist"
      aria-label="Mode"
      data-testid="mode-switch"
      className={cn(
        "flex rounded-md border border-line bg-sunken p-0.5",
        compact ? "w-[76px] flex-col gap-0.5" : "w-full gap-0.5",
      )}
    >
      {MODES.map((m) => {
        const active = m.value === mode;
        return (
          <button
            key={m.value}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={m.label}
            onClick={() => onSwitch(m.value)}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1.5 rounded-sm font-semibold transition-colors duration-[120ms]",
              "focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none max-md:min-h-[44px]",
              compact ? "flex-col py-1.5 text-10" : "px-2.5 py-1 text-13",
              active ? "bg-surface text-fg shadow-xs" : "text-muted hover:text-fg",
            )}
          >
            <Icon name={m.icon} size={compact ? 16 : 15} />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
