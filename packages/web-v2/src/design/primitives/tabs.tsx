"use client";

import { Tabs as ShadcnTabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

export function Tabs({ tabs, value, onChange }: TabsProps) {
  return (
    <ShadcnTabs value={value} onValueChange={(next) => onChange?.(next as string)} className="gap-0">
      <TabsList
        variant="line"
        className="h-auto! w-full justify-start gap-1 rounded-none border-b border-line p-0"
      >
        {tabs.map((t) => {
          const active = t.value === value;
          return (
            <TabsTrigger
              key={t.value}
              value={t.value}
              className="h-auto flex-none gap-2 rounded-sm border-0 px-3 py-2.5 text-13-5 font-semibold text-muted hover:text-fg data-active:text-fg focus-visible:ring-0 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] after:bottom-[-1px]! after:inset-x-2! after:rounded-pill after:bg-accent"
            >
              {t.label}
              {typeof t.count === "number" && <Badge tone={active ? "accent" : "neutral"}>{t.count}</Badge>}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </ShadcnTabs>
  );
}
