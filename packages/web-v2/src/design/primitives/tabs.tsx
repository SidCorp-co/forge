"use client";

import { cn } from "@/lib/utils/cn";
import { Badge } from "./badge";

export interface TabItem {
  value: string;
  label: string;
  count?: number;
}

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange?: (value: string) => void;
}

/** Underline tabs (e.g. issue detail: Activity / Tasks / Comments). */
export function Tabs({ tabs, value, onChange }: TabsProps) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.value === value);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      onChange?.(tabs[(i + dir + tabs.length) % tabs.length].value);
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange?.(tabs[0].value);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange?.(tabs[tabs.length - 1].value);
    }
  };
  return (
    <div role="tablist" className="flex items-center gap-1 border-b border-line" onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange?.(t.value)}
            className={cn(
              "relative inline-flex items-center gap-2 px-3 py-2.5 text-[13.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] focus-visible:rounded-sm",
              active ? "text-fg" : "text-muted hover:text-fg",
            )}
          >
            {t.label}
            {typeof t.count === "number" && <Badge tone={active ? "accent" : "neutral"}>{t.count}</Badge>}
            {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-pill bg-accent" />}
          </button>
        );
      })}
    </div>
  );
}
