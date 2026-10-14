

import { useEffect } from "react";
import { cn } from "@/lib/utils/cn";
import { useScrollEdges } from "../hooks/use-scroll-edges";
import { EdgeCue } from "../primitives/edge-cue";
import { Tabs, type TabsProps } from "../primitives/tabs";

interface ScreenTabsProps extends TabsProps {
  /** Max-width utility for the strip column. Defaults to the shared wide
   *  shell width (matches PageContainer). */
  width?: string;
  header?: React.ReactNode;
}

/** A strip wider than its column scrolls sideways on one line, never wrapping, and fades at the edge
 *  that hides a tab; the chosen tab is scrolled into view. */
export function ScreenTabs({ tabs, value, onChange, width = "max-w-[1720px]", header }: ScreenTabsProps) {
  const [scrollerRef, edges] = useScrollEdges<HTMLDivElement>();
  useEffect(() => {
    const strip = scrollerRef.current;
    const active = strip?.querySelector<HTMLElement>("[data-active]");
    if (!strip || !active) return;
    // only the strip moves: the page keeps its place
    const left = active.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
    if (left < strip.scrollLeft || left + active.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left - 16;
  }, [scrollerRef, value]);
  return (
    <div className={cn("mx-auto w-full px-4 pt-6 sm:px-8 sm:pt-8", width)}>
      {header}
      <div className="relative">
        <div ref={scrollerRef} className="overflow-x-auto [scrollbar-width:none]">
          <Tabs tabs={tabs} value={value} onChange={onChange} scroll />
        </div>
        <EdgeCue side="start" visible={edges.start} surface="app" />
        <EdgeCue side="end" visible={edges.end} surface="app" />
      </div>
    </div>
  );
}
