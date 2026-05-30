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
  return (
    <div role="tablist" className="flex items-center gap-1 border-b border-line">
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange?.(t.value)}
            className={cn(
              "relative inline-flex items-center gap-2 px-3 py-2.5 text-[13.5px] font-semibold transition-colors focus-visible:outline-none",
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
