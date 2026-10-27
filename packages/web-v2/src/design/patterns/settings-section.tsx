"use client";

import { type HTMLAttributes, useEffect, useRef } from "react";
import { cn } from "@/lib/utils/cn";

/** The gap left between the page's sticky top bar and a section brought up under it. */
const BELOW_TOP_BAR_PX = 12;
/** How long a section named by the fragment holds its place while what is above it arrives. */
const SETTLE_MS = 2000;
/** What the reader does that ends that hold: the page is theirs to move from then on. */
const READER_ACTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/** Where the page's sticky or fixed top bars end: what a section brought into view must sit under. */
export function stickyTopEdge(): number {
  return [...document.querySelectorAll("header")]
    .filter((h) => ["sticky", "fixed"].includes(getComputedStyle(h).position))
    .reduce((bottom, h) => Math.max(bottom, h.getBoundingClientRect().bottom), 0);
}

/** A flat settings section: no card chrome, a hairline above every one but the first. One the page's
 *  fragment names comes into view under the top bar and holds there while the page settles (ISS-1236). */
export function SettingsSection({ className, id, ...props }: HTMLAttributes<HTMLElement>) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!id || !el || window.location.hash !== `#${id}`) return;
    const land = () => {
      el.style.scrollMarginTop = `${Math.round(stickyTopEdge()) + BELOW_TOP_BAR_PX}px`;
      el.scrollIntoView?.({ block: "start" });
    };
    land();
    const grows = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(land);
    grows?.observe(el.parentElement ?? document.body);
    const stop = () => {
      grows?.disconnect();
      window.clearTimeout(timer);
      for (const act of READER_ACTS) window.removeEventListener(act, stop, true);
    };
    const timer = window.setTimeout(stop, SETTLE_MS);
    for (const act of READER_ACTS) window.addEventListener(act, stop, true);
    return stop;
  }, [id]);
  return (
    <section
      ref={ref}
      id={id}
      className={cn(
        "[&:not(:first-child)]:border-t [&:not(:first-child)]:border-line [&:not(:first-child)]:pt-6",
        className,
      )}
      {...props}
    />
  );
}
