"use client";


import { cn } from "@/lib/utils/cn";
import { Tabs, type TabsProps } from "../primitives/tabs";

export interface ScreenTabsProps extends TabsProps {
  /** Max-width utility for the strip column. Defaults to the shared wide
   *  shell width (matches PageContainer). */
  width?: string;
  header?: React.ReactNode;
}

export function ScreenTabs({ tabs, value, onChange, width = "max-w-[1720px]", header }: ScreenTabsProps) {
  return (
    <div className={cn("mx-auto w-full px-4 pt-6 sm:px-8 sm:pt-8", width)}>
      {header}
      <div className="overflow-x-auto">
        <Tabs tabs={tabs} value={value} onChange={onChange} />
      </div>
    </div>
  );
}
