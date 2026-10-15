"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { Tabs, type TabsProps } from "../primitives/tabs";

export interface ScreenTabsProps extends TabsProps {
  /** Max-width utility for the strip column. Defaults to the shared wide
   *  shell width (matches PageContainer). */
  width?: string;
  header?: React.ReactNode;
}

/** Which ends of a sideways-scrolling strip still hide tabs. */
interface Hidden {
  before: boolean;
  after: boolean;
}

function hiddenEnds(el: HTMLElement): Hidden {
  return {
    before: el.scrollLeft > 1,
    after: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
  };
}

/** The edge of a strip that hides tabs: a fade over the cut tab and a chevron saying more are there. */
function MoreTabs({ side }: { side: "before" | "after" }) {
  const Icon = side === "before" ? ChevronLeft : ChevronRight;
  return (
    <span
      aria-hidden
      data-testid={`more-tabs-${side}`}
      className={cn(
        "pointer-events-none absolute inset-y-0 bottom-px flex w-12 items-center from-app via-app/90 to-transparent text-muted",
        side === "before" ? "left-0 justify-start bg-gradient-to-r" : "right-0 justify-end bg-gradient-to-l",
      )}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

export function ScreenTabs({ tabs, value, onChange, width = "max-w-[1720px]", header }: ScreenTabsProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Hidden>({ before: false, after: false });

  // A strip wider than the screen scrolls sideways, and says so at the end that hides tabs.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const next = hiddenEnds(el);
      setHidden((cur) => (cur.before === next.before && cur.after === next.after ? cur : next));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resized?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      resized?.disconnect();
    };
  }, []);

  // The open tab is never one of the hidden ones.
  const openAt = tabs.findIndex((t) => t.value === value);
  useEffect(() => {
    const open = scroller.current?.querySelectorAll<HTMLElement>('[role="tab"]')[openAt];
    open?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [openAt]);

  return (
    <div className={cn("mx-auto w-full px-4 pt-6 sm:px-8 sm:pt-8", width)}>
      {header}
      <div className="relative">
        <div ref={scroller} className="overflow-x-auto">
          <Tabs tabs={tabs} value={value} onChange={onChange} />
        </div>
        {hidden.before && <MoreTabs side="before" />}
        {hidden.after && <MoreTabs side="after" />}
      </div>
    </div>
  );
}
