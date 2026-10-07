"use client";


import { cn } from "@/lib/utils/cn";
import { useScrollEdges } from "../hooks/use-scroll-edges";
import { EdgeCue } from "../primitives/edge-cue";
import { Tabs, type TabsProps } from "../primitives/tabs";

export interface ScreenTabsProps extends TabsProps {
  /** Max-width utility for the strip column. Defaults to the shared wide
   *  shell width (matches PageContainer). */
  width?: string;
  header?: React.ReactNode;
}

/** A strip wider than its column scrolls sideways, and fades at the edge that hides a tab. */
export function ScreenTabs({ tabs, value, onChange, width = "max-w-[1720px]", header }: ScreenTabsProps) {
  const [scrollerRef, edges] = useScrollEdges<HTMLDivElement>();
  return (
    <div className={cn("mx-auto w-full px-4 pt-6 sm:px-8 sm:pt-8", width)}>
      {header}
      <div className="relative">
        <div ref={scrollerRef} className="overflow-x-auto [scrollbar-width:none]">
          <Tabs tabs={tabs} value={value} onChange={onChange} />
        </div>
        <EdgeCue side="start" visible={edges.start} surface="app" />
        <EdgeCue side="end" visible={edges.end} surface="app" />
      </div>
    </div>
  );
}
