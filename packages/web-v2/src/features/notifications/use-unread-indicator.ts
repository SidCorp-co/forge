"use client";

// Always-visible unread indicator hook (ISS-523).
//
// Mirrors the unread count into the browser-tab favicon (a dot) and the document
// title (a `(N)` prefix), so an unread notification is visible whether or not the
// tab is focused — covering the gap left by the background-only native channel.
// Driven by the same `useUnreadCount()` the header bell reads, so the two never
// disagree. The DOM work lives in lib/notifications/favicon (SSR-safe, never
// throws); this hook is just the count → effect wiring.
import { useEffect } from "react";
import { setFaviconBadge, setTitleUnread } from "@/lib/notifications/favicon";

/** Reflect `count` unread notifications onto the favicon + document title.
 *  Mount once (workspace layout). Resets to the clean state on unmount. */
export function useUnreadIndicator(count: number): void {
  useEffect(() => {
    setFaviconBadge(count > 0);
    setTitleUnread(count);
    return () => {
      setFaviconBadge(false);
      setTitleUnread(0);
    };
  }, [count]);
}
