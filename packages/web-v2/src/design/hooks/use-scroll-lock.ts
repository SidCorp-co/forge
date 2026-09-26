"use client";

import { type RefObject, useEffect, useRef } from "react";

function scrollsFurther(el: HTMLElement, deltaY: number): boolean {
  const { overflowY } = getComputedStyle(el);
  if (overflowY !== "auto" && overflowY !== "scroll") return false;
  if (deltaY < 0) return el.scrollTop > 0;
  if (deltaY > 0) return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  return false;
}

/**
 * Holds the page still while a floating surface is open: a wheel or touch
 * scroll is cancelled unless it lands inside one of `inside` AND something
 * there can still scroll that way. The workspace scrolls `<main>`, not the
 * document, so `overflow: hidden` on the body would lock nothing.
 */
export function useScrollLock(
  active: boolean,
  inside: ReadonlyArray<RefObject<HTMLElement | null>>,
): void {
  const insideRef = useRef(inside);
  insideRef.current = inside;
  useEffect(() => {
    if (!active) return;
    const home = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Node)) return null;
      for (const ref of insideRef.current) {
        if (ref.current?.contains(target)) return ref.current;
      }
      return null;
    };
    const onWheel = (e: WheelEvent) => {
      const root = home(e.target);
      if (root) {
        for (let n = e.target as HTMLElement | null; n; n = n.parentElement) {
          if (scrollsFurther(n, e.deltaY)) return;
          if (n === root) break;
        }
      }
      e.preventDefault();
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!home(e.target)) e.preventDefault();
    };
    const opts = { capture: true, passive: false } as const;
    document.addEventListener("wheel", onWheel, opts);
    document.addEventListener("touchmove", onTouchMove, opts);
    return () => {
      document.removeEventListener("wheel", onWheel, opts);
      document.removeEventListener("touchmove", onTouchMove, opts);
    };
  }, [active]);
}
