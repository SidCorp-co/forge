"use client";

import { type RefObject, useEffect, useRef, useState } from "react";

/** Which sides of a horizontal scroller have content out of view. */
export interface ScrollEdges {
  start: boolean;
  end: boolean;
}

const NONE: ScrollEdges = { start: false, end: false };

// Fractional layout widths leave a sub-pixel remainder that is not content anyone can miss.
const TOLERANCE_PX = 1;

export function measureScrollEdges(el: HTMLElement): ScrollEdges {
  const hidden = el.scrollWidth - el.clientWidth;
  if (hidden <= TOLERANCE_PX) return NONE;
  const offset = Math.abs(el.scrollLeft);
  return { start: offset > TOLERANCE_PX, end: hidden - offset > TOLERANCE_PX };
}

/**
 * Tracks {@link ScrollEdges} for the element the returned ref is attached to,
 * re-measuring on scroll and whenever the scroller or one of its children
 * changes size — rows arriving widen a table without the scroller resizing.
 */
export function useScrollEdges<T extends HTMLElement>(): [RefObject<T | null>, ScrollEdges] {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState<ScrollEdges>(NONE);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const next = measureScrollEdges(el);
      setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (observer) {
      observer.observe(el);
      for (const child of Array.from(el.children)) observer.observe(child);
    }
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);

  return [ref, edges];
}
