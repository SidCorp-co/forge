"use client";

import { type RefObject, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { breakpointWidth } from "@/lib/utils/breakpoint-width";
import { usePersistedState } from "@/lib/utils/use-persisted-state";

/** The bare anchor a focused canvas keeps in the address, so it can be linked and survives a reload. */
const CANVAS_ANCHOR = "#canvas";

/** Out of focus mode, the canvas keeps at least this share of the viewport's height. */
export const CANVAS_SHARE = 0.6;

/** Below this width the page stacks and scrolls (the `lg` breakpoint), so no share is held. */
const ROOM_MIN_WIDTH = 1024;

const BANNER_OPEN_KEY = "web-v2:workflows.design-banner-open";
const RAIL_COLLAPSED_KEY = "web-v2:workflows.design-rail-collapsed";

const anchored = () => typeof window !== "undefined" && window.location.hash === CANVAS_ANCHOR;

/** Focus mode, read from and written to the address's `#canvas` anchor; a hand-edited anchor is followed too. */
export function useCanvasFocus(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribeAnchor, anchored, () => false);
  const set = (next: boolean) => {
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${search}${next ? CANVAS_ANCHOR : ""}`);
    // replaceState fires no hashchange: tell the readers it moved
    for (const listener of anchorListeners) listener();
  };
  return [on, set];
}

const anchorListeners = new Set<() => void>();

function subscribeAnchor(onChange: () => void): () => void {
  anchorListeners.add(onChange);
  window.addEventListener("hashchange", onChange);
  return () => {
    anchorListeners.delete(onChange);
    window.removeEventListener("hashchange", onChange);
  };
}

/** A per-viewer boolean kept in this browser; storage that throws or holds a non-boolean reads as `false`. */
function useViewerFlag(key: string): [boolean, (on: boolean) => void] {
  const [raw, set] = usePersistedState<unknown>(key, false);
  return [raw === true, set];
}

/** Whether the decision banner shows its detail (the note, the return reason, what approving leaves stale). */
export const useBannerOpen = () => useViewerFlag(BANNER_OPEN_KEY);

/** Whether the design's facts rail is folded away, giving the canvas the page's full width. */
export const useRailCollapsed = () => useViewerFlag(RAIL_COLLAPSED_KEY);

interface RoomMeasure {
  /** The width the page's `lg` breakpoint reads (breakpointWidth): the window's, or the page's while the Ask Agent panel is beside it. */
  width: number;
  viewportHeight: number;
  /** The design view's column: the viewport less the page's top bar. */
  column: number;
  /** Everything stacked above the canvas, as laid out now. */
  head: number;
  /** The banner's detail, as last laid out (0 when it has never been shown). */
  detail: number;
  /** The detail is laid in the flow now (shown, and not floating over the canvas), so `head` already counts it. */
  detailInFlow: boolean;
}

/**
 * The detail, laid in the flow, would leave the canvas under its share of the viewport. Measured
 * against the head without the detail, so showing or hiding it never flips the answer.
 */
export function detailSqueezes(m: RoomMeasure): boolean {
  if (m.width < ROOM_MIN_WIDTH || m.detail <= 0) return false;
  const headWithout = m.head - (m.detailInFlow ? m.detail : 0);
  return m.column - headWithout - m.detail < CANVAS_SHARE * m.viewportHeight;
}

/**
 * Re-reads `detailSqueezes` whenever the column, the head or the detail changes size, and whenever
 * the detail is opened or folded. The detail's height outlives its hiding, so a squeezed banner
 * stays compact instead of reopening to measure.
 */
export function useDetailSqueezes(
  column: RefObject<HTMLElement | null>,
  head: RefObject<HTMLElement | null>,
  detail: RefObject<HTMLElement | null>,
  o: { active: boolean; open: string },
): boolean {
  const { active, open } = o;
  const [squeezed, setSqueezed] = useState(false);
  const lastDetailRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: opening or folding the detail is a trigger to re-measure, not an input
  useLayoutEffect(() => {
    if (!active) return;
    const read = () => {
      const c = column.current;
      const h = head.current;
      const d = detail.current;
      if (!c || !h) return;
      const shown = Boolean(d && !d.hidden);
      if (d && shown) lastDetailRef.current = d.getBoundingClientRect().height;
      setSqueezed(
        detailSqueezes({
          width: breakpointWidth(c),
          viewportHeight: window.innerHeight,
          column: c.getBoundingClientRect().height,
          head: h.getBoundingClientRect().height,
          detail: lastDetailRef.current,
          detailInFlow: shown && d?.dataset.float !== "true",
        }),
      );
    };
    read();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    for (const el of [column.current, head.current, detail.current]) if (el) ro?.observe(el);
    window.addEventListener("resize", read);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [column, head, detail, active, open]);
  return squeezed;
}
