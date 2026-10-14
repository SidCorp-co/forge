// A long page's contents: the groups it draws, each a link to where it starts, with the group in view
// marked. Beside a facts rail it is a vertical list at the rail's top, sticky with the rail; where
// there is no rail (below 1024px, or a page without one) it is one compact menu at the top of the
// content, never a wrapped row of links.

import { useEffect, useMemo, useState } from "react";
import { Button } from "../primitives/button";
import { cn } from "@/lib/utils/cn";
import { Menu } from "./menu";

export interface ContentsItem {
  /** The id of the element the group starts at. */
  id: string;
  label: string;
}

/** The marker line: a group is "in view" once its top has passed this far down the viewport. */
function markerLine(): number {
  return Math.max(160, window.innerHeight * 0.3);
}

/** The group the reader is in: the last whose top has passed the marker line, the last group at the page's end. */
export function useCurrentAnchor(ids: readonly string[]): string | null {
  const key = ids.join("|");
  const list = useMemo(() => (key === "" ? [] : key.split("|")), [key]);
  const [current, setCurrent] = useState<string | null>(list[0] ?? null);
  useEffect(() => {
    if (list.length === 0) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const line = markerLine();
      let at = list[0] ?? null;
      for (const id of list) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) at = id;
      }
      const last = list[list.length - 1];
      const lastEl = last ? document.getElementById(last) : null;
      // the page cannot scroll the last group up to the line: it is current once its end is on screen
      if (last && lastEl && lastEl.getBoundingClientRect().bottom <= window.innerHeight && lastEl.getBoundingClientRect().top < window.innerHeight) {
        const scroller = scrollerOf(lastEl);
        if (scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) at = last;
      }
      setCurrent(at);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    frame = requestAnimationFrame(read);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [list]);
  return current;
}

function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  const page = document.scrollingElement ?? document.documentElement;
  return page instanceof HTMLElement ? page : null;
}

function go(id: string) {
  document.getElementById(id)?.scrollIntoView({ block: "start" });
}

/** The vertical list at the top of a facts rail: one link per group, the group in view marked. */
export function ContentsList({ items, label, testId }: { items: readonly ContentsItem[]; label: string; testId?: string }) {
  const current = useCurrentAnchor(items.map((i) => i.id));
  if (items.length < 2) return null;
  return (
    <nav aria-label={label} className="border-b border-line-subtle pb-3.5 mb-3.5" data-testid={testId ?? "contents-list"}>
      <h3 className="mb-2 text-14 font-bold text-accent-text">{label}</h3>
      <ol className="grid">
        {items.map((i) => {
          const here = i.id === current;
          return (
            <li key={i.id}>
              <a
                href={`#${i.id}`}
                aria-current={here ? "location" : undefined}
                className={cn(
                  "-ml-px block border-l-2 py-1 pl-3 text-13 no-underline transition-colors",
                  here ? "border-accent font-semibold text-fg" : "border-line-subtle text-muted hover:text-fg",
                )}
                data-testid={`${testId ?? "contents-list"}-${i.id}`}
              >
                {i.label}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The same contents as one control: a button naming the group in view, opening the list of groups. */
export function ContentsMenu({ items, label, testId, className }: { items: readonly ContentsItem[]; label: string; testId?: string; className?: string }) {
  const current = useCurrentAnchor(items.map((i) => i.id));
  if (items.length < 2) return null;
  const here = items.find((i) => i.id === current) ?? items[0];
  return (
    <nav aria-label={label} className={cn("sticky top-0 z-10 bg-app py-2", className)} data-testid={testId ?? "contents-menu"}>
      <Menu
        align="left"
        items={items.map((i) => ({ label: i.label, checked: i.id === current, onSelect: () => go(i.id) }))}
        trigger={
          <Button size="sm" icon="chevronDown" aria-label={`${label}: ${here?.label ?? ""}`} data-testid={`${testId ?? "contents-menu"}-trigger`}>
            <span className="text-muted">{label}</span>
            <span className="text-neutral-8">·</span>
            <span>{here?.label}</span>
          </Button>
        }
      />
    </nav>
  );
}
