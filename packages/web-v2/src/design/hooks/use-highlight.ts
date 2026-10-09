"use client";

// One highlight on the page beside the chat at a time (REQ-41 BC-6): the chat's ui.highlight names a
// section, a workflow step or a row, the page scrolls to it and marks it with the shared
// `.forge-highlight` style. The page reports it as highlighted only once the element is on screen,
// and only on the path it was made for, so the snapshot never claims a mark the person cannot see.

import type { UiHighlight } from "@forge/contracts/ui-actions";
import { useSyncExternalStore } from "react";

export interface HighlightState {
  h: UiHighlight;
  /** The page path the highlight was made on; another path shows none. */
  path: string;
  /** True once the element is on screen and marked. */
  shown: boolean;
}

/** How long a highlight waits for its element (a tab switching, a list loading) before it gives up. */
export const HIGHLIGHT_WAIT_MS = 4000;
const MARK = "data-highlighted";

let state: HighlightState | null = null;
let marked: Element | null = null;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();
const emit = (next: HighlightState | null) => {
  state = next;
  for (const l of listeners) l();
};

function unmark() {
  marked?.classList.remove("forge-highlight");
  marked?.removeAttribute(MARK);
  marked = null;
}

export const highlightStore = {
  get: (): HighlightState | null => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  clear() {
    stop?.();
    unmark();
    emit(null);
  },
};

/**
 * Marks what `find` returns once it is on the page: scrolled into view and flashed. While it is not
 * there yet (a tab switching, rows loading) it waits up to `HIGHLIGHT_WAIT_MS`, then drops the
 * highlight and calls `onMiss`, so a mark that never landed is never reported.
 */
export function highlightOnPage(h: UiHighlight, path: string, find: () => Element | null, onMiss?: () => void): void {
  stop?.();
  unmark();
  emit({ h, path, shown: false });
  const land = (el: Element) => {
    el.scrollIntoView?.({ block: "center", behavior: "smooth" });
    el.classList.remove("forge-highlight");
    // restarts the flash on an element marked before
    void (el as HTMLElement).offsetWidth;
    el.classList.add("forge-highlight");
    el.setAttribute(MARK, "true");
    marked = el;
    emit({ h, path, shown: true });
  };
  const now = find();
  if (now) {
    land(now);
    return;
  }
  const observer = new MutationObserver(() => {
    const el = find();
    if (!el) return;
    end();
    land(el);
  });
  const timer = setTimeout(() => {
    end();
    emit(null);
    onMiss?.();
  }, HIGHLIGHT_WAIT_MS);
  function end() {
    observer.disconnect();
    clearTimeout(timer);
    stop = null;
  }
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  stop = end;
}

/** The highlight the page at `path` shows, or null. */
export function useHighlight(path: string): UiHighlight | null {
  const s = useSyncExternalStore(highlightStore.subscribe, highlightStore.get, () => null);
  return s?.shown && s.path === path ? s.h : null;
}
