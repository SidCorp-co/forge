"use client";

// Always-visible open-count indicator hook (ISS-523, ISS-1063).
//
// Mirrors the open count into the browser-tab favicon (a dot) and the document
// title (a `(N)` prefix), so something still true is visible whether or not the
// tab is focused — covering the gap left by the background-only native channel.
// Driven by the same `useOpenCount()` the header bell reads, so the two never
// disagree. The DOM work lives in lib/notifications/favicon (SSR-safe, never
// throws); this hook is just the count → effect wiring.
//
// ISS-1063 — the number is records still true, not deliveries nobody opened.
// Reading the bell no longer clears the tab title, and that is the point: the
// title said nothing was left while 5663 conditions were still firing.
import { useEffect } from "react";
import { setFaviconBadge, setTitleOpenCount } from "@/lib/notifications/favicon";

/** Reflect `count` still-true notifications onto the favicon + document title.
 *  Mount once (workspace layout). Resets to the clean state on unmount. */
export function useOpenIndicator(count: number): void {
  useEffect(() => {
    setFaviconBadge(count > 0);
    setTitleOpenCount(count);
    return () => {
      setFaviconBadge(false);
      setTitleOpenCount(0);
    };
  }, [count]);
}
