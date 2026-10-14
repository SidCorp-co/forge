"use client";

// The one importer of @tanstack/react-virtual: it hands back plain numbers and callbacks, so no
// library type reaches a feature. The row that holds focus is always among the rows returned, found
// by its key, so rows inserted or reordered above it do not move the hold to another row.

import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  type FocusEvent,
  type RefObject,
  type UIEvent,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";

export interface VirtualRowsOptions {
  /** How many rows the list holds, drawn or not. */
  count: number;
  /** The height a row is taken to have until it has been measured. */
  estimateSize: number;
  /** Rows drawn beyond the edge of the view, each side. */
  overscan?: number;
  /** A stable key for a row, so a measured height follows the row when the rows reorder. */
  getKey?: (index: number) => string | number;
  /** False draws no window at all: every field comes back empty. */
  enabled?: boolean;
  /** The scroller's height before it has been measured, so a server render draws the first screen. */
  initialHeight?: number;
  /** Space the scroller keeps clear at its start (a stuck header) when it scrolls a row into view. */
  scrollPaddingStart?: number;
}

export interface VirtualRow {
  index: number;
  key: string | number;
  /** Where the row starts, from the top of the scrolled content. */
  start: number;
  /** The height of rows not drawn between the previous drawn row (or the top) and this one. */
  gapBefore: number;
}

export interface VirtualRows {
  scrollerRef: RefObject<HTMLDivElement | null>;
  rows: VirtualRow[];
  /** The height all the rows add up to, drawn or not. */
  totalSize: number;
  /** The height of rows not drawn after the last drawn one. */
  gapAfter: number;
  /** The last row the scroll position has reached, overscan included: not the row held for focus, which may sit far behind it. */
  reached: number;
  /** Ref for each drawn row, which carries `data-index`: it reports the row's measured height. */
  measureRow: (node: Element | null) => void;
  /** Spread on the scroller: it learns which row holds focus, and re-aims a scroll that ends at the end of rows not yet measured. */
  scrollerEvents: {
    onFocus: (event: FocusEvent<HTMLElement>) => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
    onScroll: (event: UIEvent<HTMLElement>) => void;
  };
  /** Scrolls row `index` into the document and into view, then puts focus on it. */
  focusRow: (index: number) => void;
}

const ROW = "[data-index]";

/** Where the held row is now: where it was if it still has that key, else wherever that key went, else -1. */
function heldIndex(
  held: { key: string | number; index: number },
  count: number,
  getKey: ((index: number) => string | number) | undefined,
): number {
  if (!getKey) return held.index < count ? held.index : -1;
  if (held.index < count && getKey(held.index) === held.key) return held.index;
  for (let i = 0; i < count; i++) {
    if (getKey(i) === held.key) {
      held.index = i;
      return i;
    }
  }
  return -1;
}

export function useVirtualRows({
  count,
  estimateSize,
  overscan = 6,
  getKey,
  enabled = true,
  initialHeight = 0,
  scrollPaddingStart,
}: VirtualRowsOptions): VirtualRows {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const held = useRef<{ key: string | number; index: number } | null>(null);
  const pending = useRef<number | null>(null);

  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: enabled ? count : 0,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => estimateSize,
    overscan,
    getItemKey: getKey,
    initialRect: { width: 0, height: initialHeight },
    scrollPaddingStart,
    rangeExtractor: (range) => {
      const drawn = defaultRangeExtractor(range);
      const keep = held.current === null ? -1 : heldIndex(held.current, range.count, getKey);
      if (keep === -1 || drawn.includes(keep)) return drawn;
      return [...drawn, keep].sort((a, b) => a - b);
    },
  });

  const items = enabled ? virtualizer.getVirtualItems() : [];
  let reached = 0;
  const rows = items.map((item) => {
    const row: VirtualRow = {
      index: item.index,
      key: item.key as string | number,
      start: item.start,
      gapBefore: Math.max(0, item.start - reached),
    };
    reached = item.end;
    return row;
  });
  const totalSize = enabled ? virtualizer.getTotalSize() : 0;
  const reachedIndex = enabled && virtualizer.range ? Math.min(count - 1, virtualizer.range.endIndex + overscan) : -1;

  const settle = useCallback(() => {
    const wanted = pending.current;
    if (wanted === null) return;
    const node = scrollerRef.current?.querySelector<HTMLElement>(`[data-index="${wanted}"]`);
    if (!node) return;
    pending.current = null;
    node.focus();
  }, []);

  // A row scrolled to by keyboard is only in the document after the render that follows the scroll.
  useLayoutEffect(settle);

  const focusRow = useCallback(
    (index: number) => {
      pending.current = index;
      held.current = { key: getKey?.(index) ?? index, index };
      virtualizer.scrollToIndex(index, { align: "auto" });
      settle();
    },
    [virtualizer, settle, getKey],
  );

  // A jump to the end is aimed at estimated rows and rests short: aim at the last row again from the
  // bottom and the library settles on it as the rows measure. The aim's own events are not answered.
  const aimedFrom = useRef<{ top: number; height: number } | null>(null);
  const reachedEnd = (event: UIEvent<HTMLElement>) => {
    const scroller = event.currentTarget;
    const { scrollTop, clientHeight, scrollHeight } = scroller;
    if (!enabled || count === 0 || scrollHeight === 0 || scrollTop + clientHeight < scrollHeight - 1) {
      aimedFrom.current = null;
      return;
    }
    if (aimedFrom.current?.top === scrollTop && aimedFrom.current.height === scrollHeight) return;
    aimedFrom.current = { top: scrollTop, height: scrollHeight };
    virtualizer.scrollToIndex(count - 1, { align: "end" });
  };

  const scrollerEvents = {
    onScroll: reachedEnd,
    onFocus: (event: FocusEvent<HTMLElement>) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(ROW);
      if (!row || !event.currentTarget.contains(row)) {
        held.current = null;
        return;
      }
      const index = Number(row.dataset.index);
      held.current = { key: getKey?.(index) ?? index, index };
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget as Node | null;
      if (!next || !event.currentTarget.contains(next)) held.current = null;
    },
  };

  return {
    scrollerRef,
    rows,
    totalSize,
    reached: reachedIndex,
    gapAfter: rows.length === 0 ? totalSize : Math.max(0, totalSize - reached),
    measureRow: virtualizer.measureElement,
    scrollerEvents,
    focusRow,
  };
}
