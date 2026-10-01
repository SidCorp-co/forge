"use client";

import { Icon, type IconName } from "@/design";
import { Menu } from "@/design/patterns/menu";
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
  if (!compact) return <ModeSelect mode={mode} onSwitch={onSwitch} />;
  return (
    <div
      role="tablist"
      aria-label="Mode"
      data-testid="mode-switch"
      className={cn(
        "flex rounded-md bg-sunken p-0.5",
        compact ? "w-[76px] flex-col gap-0.5 border border-line" : "flex-none gap-0.5",
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
              "inline-flex items-center justify-center rounded-sm font-semibold transition-colors duration-[120ms]",
              "focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none",
              compact ? "flex-1 flex-col gap-1.5 py-1.5 text-10" : "px-1.5 py-[3px] text-11-5",
              active ? "bg-surface text-fg shadow-xs" : "text-muted hover:text-fg",
            )}
          >
            {compact && <Icon name={m.icon} size={16} />}
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

function ModeSelect({ mode, onSwitch }: { mode: ShellMode; onSwitch: (to: ShellMode) => void }) {
  const current = MODES.find((m) => m.value === mode) ?? MODES[0];
  return (
    <Menu
      align="left"
      className="min-w-0 flex-1"
      triggerClassName="block w-full min-w-0"
      items={MODES.map((m) => ({
        label: `Forge ${m.label}`,
        icon: m.icon,
        checked: m.value === mode,
        onSelect: () => onSwitch(m.value),
      }))}
      trigger={
        <button
          type="button"
          data-testid="mode-switch"
          aria-label={`Mode: ${current.label}`}
          className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-hover focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none"
        >
          <span className="fg-h3 min-w-0 flex-1 truncate" style={{ fontSize: "var(--text-16)" }}>
            Forge <span className="text-muted">{current.label}</span>
          </span>
          <Icon name="chevronDown" size={14} className="flex-none text-subtle" />
        </button>
      }
    />
  );
}
