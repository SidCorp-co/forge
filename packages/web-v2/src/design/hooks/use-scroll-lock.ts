"use client";

import { type RefObject, useEffect, useRef } from "react";

type Roots = { current: ReadonlyArray<RefObject<HTMLElement | null>> };

function scrollsFurther(el: HTMLElement, deltaY: number): boolean {
  const { overflowY } = getComputedStyle(el);
  if (overflowY !== "auto" && overflowY !== "scroll") return false;
  if (deltaY < 0) return el.scrollTop > 0;
  if (deltaY > 0) return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  return false;
}

// One listener for every open surface: a per-surface listener would cancel a
// scroll inside a second open surface as "outside" the first.
const open = new Set<Roots>();

function home(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Node)) return null;
  for (const roots of open) {
    for (const ref of roots.current) {
      if (ref.current?.contains(target)) return ref.current;
    }
  }
  return null;
}

/** Whether a scroll of `deltaY` at `target` moves something inside an open surface. */
function scrollsInside(target: EventTarget | null, deltaY: number): boolean {
  const root = home(target);
  if (!root) return false;
  for (let n = target as HTMLElement | null; n; n = n.parentElement) {
    if (scrollsFurther(n, deltaY)) return true;
    if (n === root) break;
  }
  return false;
}

function onWheel(e: WheelEvent) {
  if (!scrollsInside(e.target, e.deltaY)) e.preventDefault();
}

let touchY = 0;
function onTouchStart(e: TouchEvent) {
  touchY = e.touches[0]?.clientY ?? 0;
}
function onTouchMove(e: TouchEvent) {
  const y = e.touches[0]?.clientY ?? touchY;
  if (!scrollsInside(e.target, touchY - y)) e.preventDefault();
  touchY = y;
}

const OPTS = { capture: true, passive: false } as const;
const WATCH = { capture: true, passive: true } as const;

/**
 * Holds the page still while a floating surface is open: a wheel or touch
 * scroll is cancelled unless it lands inside an open surface AND something
 * there can still scroll that way (a touch's way is read off its drag). The
 * workspace scrolls `<main>`, not the document, so `overflow: hidden` on the
 * body would lock nothing.
 */
export function useScrollLock(
  active: boolean,
  inside: ReadonlyArray<RefObject<HTMLElement | null>>,
): void {
  const roots = useRef(inside);
  roots.current = inside;
  useEffect(() => {
    if (!active) return;
    const entry: Roots = roots;
    if (open.size === 0) {
      document.addEventListener("wheel", onWheel, OPTS);
      document.addEventListener("touchstart", onTouchStart, WATCH);
      document.addEventListener("touchmove", onTouchMove, OPTS);
    }
    open.add(entry);
    return () => {
      open.delete(entry);
      if (open.size === 0) {
        document.removeEventListener("wheel", onWheel, OPTS);
        document.removeEventListener("touchstart", onTouchStart, WATCH);
        document.removeEventListener("touchmove", onTouchMove, OPTS);
      }
    };
  }, [active]);
}
