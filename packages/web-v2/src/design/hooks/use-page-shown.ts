"use client";

// The rows the list beside the chat shows, top first (REQ-41 BC-8): every list reports its visible row
// keys here while it is on screen, and the page snapshot each message carries reads them, so "the
// first one" in the person's message means the row they see first. One list reports at a time; the
// one that unmounts takes its report with it, so a page with no list reports none.

import { UI_SHOWN_MAX } from "@forge/contracts/ui-actions";
import { useEffect, useSyncExternalStore } from "react";

let shown: readonly string[] | null = null;
let owner: symbol | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export const pageShown = {
  get: (): readonly string[] | null => shown,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** Report `keys` as the shown rows on behalf of `by`; capped at the snapshot's limit. */
  report(by: symbol, keys: readonly string[]) {
    owner = by;
    shown = keys.slice(0, UI_SHOWN_MAX);
    emit();
  },
  /** Drop the report `by` made, and only that one. */
  drop(by: symbol) {
    if (owner !== by) return;
    owner = null;
    shown = null;
    emit();
  },
};

/** Reports the list's visible row keys, in order, while the calling list is mounted. */
export function useReportShown(keys: readonly string[]): void {
  const joined = keys.slice(0, UI_SHOWN_MAX).join("\n");
  useEffect(() => {
    const me = Symbol("shown");
    pageShown.report(me, joined ? joined.split("\n") : []);
    return () => pageShown.drop(me);
  }, [joined]);
}

/** The keys the page's list shows, or null where no list is on screen. */
export function useShownKeys(): readonly string[] | null {
  return useSyncExternalStore(pageShown.subscribe, pageShown.get, () => null);
}
