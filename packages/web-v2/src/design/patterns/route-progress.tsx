"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useIsFetching } from "@tanstack/react-query";

/** Hard ceiling on how long the bar may stay visible. Even if the destination's
 *  React Query fetches never drain (per-row lazy queries + `retry` keep the
 *  GLOBAL `useIsFetching()` count > 0), the bar force-completes after this so it
 *  can never hang at ~90% (ISS-366 D1). */
const SAFETY_TIMEOUT_MS = 8000;

/** Top flame progress bar during client navigations — lib-free. Starts on
    link click / history change, trickles to ~90%, and completes once the
    destination route has settled AND its React Query fetches have drained
    (`useIsFetching() === 0`) — or, failing that, when the safety timeout fires.
    Gating on data-ready stops the bar reporting "done" while the new page is
    still loading (ISS-308 A2); the safety timeout stops it hanging forever when
    the global fetch count never reaches 0 (ISS-366 D1). A same-path
    `history.replaceState` (the Issues list syncing its filter/sort into the URL
    query) must NOT re-arm the bar, otherwise `startPath` resets to the current
    path and the completion guard never clears. In-page hash links are ignored.
    Mount once in layout. */
export function RouteProgress() {
  const pathname = usePathname();
  const fetching = useIsFetching();
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const trickle = useRef<ReturnType<typeof setInterval> | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hard-stop timer armed when the bar appears; force-completes the bar.
  const maxHide = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pathname captured when a navigation begins. The completion effect waits
  // until usePathname() actually differs from this — otherwise the brief
  // fetching===0 window between "navigation started" and "destination query
  // registered" would complete the bar before the route even changed.
  const startPath = useRef<string | null>(null);

  // Force-complete: snap to 100%, then fade out. Used both by the data-ready
  // effect and the safety timeout. Clears every pending timer/interval.
  const finish = useCallback(() => {
    if (trickle.current) clearInterval(trickle.current);
    if (maxHide.current) {
      clearTimeout(maxHide.current);
      maxHide.current = null;
    }
    setWidth(100);
    if (hide.current) clearTimeout(hide.current);
    hide.current = setTimeout(() => {
      setVisible(false);
      setWidth(0);
    }, 300);
  }, []);

  useEffect(() => {
    const start = () => {
      if (hide.current) clearTimeout(hide.current);
      startPath.current = location.pathname;
      setVisible(true);
      setWidth(8);
      if (trickle.current) clearInterval(trickle.current);
      trickle.current = setInterval(() => setWidth((w) => (w < 90 ? w + (90 - w) * 0.12 : w)), 200);
      // Belt-and-braces: never let the bar trickle forever.
      if (maxHide.current) clearTimeout(maxHide.current);
      maxHide.current = setTimeout(finish, SAFETY_TIMEOUT_MS);
    };

    // A history update whose target pathname equals the current one is a
    // query-only sync (e.g. the Issues list writing filter/sort state) — it is
    // NOT a navigation and must not (re-)start the bar. When the URL arg is
    // absent or unparseable we can't tell, so fall back to starting.
    const isSamePath = (url: unknown): boolean => {
      if (url == null) return false;
      try {
        return new URL(String(url), location.href).pathname === location.pathname;
      } catch {
        return false;
      }
    };

    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (...a: Parameters<typeof origPush>) { if (!isSamePath(a[2])) start(); return origPush.apply(this, a); };
    history.replaceState = function (...a: Parameters<typeof origReplace>) { if (!isSamePath(a[2])) start(); return origReplace.apply(this, a); };
    const onPop = () => start();
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || a.target || e.metaKey || e.ctrlKey || e.shiftKey) return;
      try {
        const url = new URL(a.href);
        if (url.origin !== location.origin) return;
        if (url.pathname === location.pathname) return; // in-page hash / same route
        start();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("click", onClick, true);
    return () => {
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick, true);
      if (trickle.current) clearInterval(trickle.current);
      if (maxHide.current) clearTimeout(maxHide.current);
    };
  }, [finish]);

  useEffect(() => {
    if (!visible) return;
    // Wait until the route has actually settled (pathname differs from where the
    // navigation began) before considering completion.
    if (startPath.current !== null && pathname === startPath.current) return;
    // The route has changed but the destination may still be fetching — keep
    // trickling toward 90% until in-flight queries drain, then complete. Bounded
    // by the safety timeout armed in start() so a stuck global fetch count can't
    // pin the bar here forever.
    if (fetching > 0) return;
    // Complete only once the resolved pathname has settled AND data is ready.
    finish();
  }, [pathname, fetching, visible, finish]);

  return (
    <div
      aria-hidden
      style={{ position: "fixed", insetInline: 0, top: 0, height: 2, zIndex: 80, pointerEvents: "none", opacity: visible ? 1 : 0, transition: "opacity 200ms var(--ease-out)" }}
    >
      <div style={{ height: "100%", width: `${width}%`, background: "var(--accent)", boxShadow: "0 0 8px var(--flame-300)", transition: "width 200ms var(--ease-out)" }} />
    </div>
  );
}
