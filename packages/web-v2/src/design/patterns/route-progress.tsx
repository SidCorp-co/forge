"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useIsFetching } from "@tanstack/react-query";

/** Top flame progress bar during client navigations — lib-free. Starts on
    link click / history change, trickles to ~90%, and only completes once the
    destination route has settled AND its React Query fetches have drained
    (`useIsFetching() === 0`). Gating on data-ready stops the bar reporting
    "done" while the new page is still loading (ISS-308 A2). In-page hash links
    are ignored. Mount once in layout. */
export function RouteProgress() {
  const pathname = usePathname();
  const fetching = useIsFetching();
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const trickle = useRef<ReturnType<typeof setInterval> | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pathname captured when a navigation begins. The completion effect waits
  // until usePathname() actually differs from this — otherwise the brief
  // fetching===0 window between "navigation started" and "destination query
  // registered" would complete the bar before the route even changed.
  const startPath = useRef<string | null>(null);

  useEffect(() => {
    const start = () => {
      if (hide.current) clearTimeout(hide.current);
      startPath.current = location.pathname;
      setVisible(true);
      setWidth(8);
      if (trickle.current) clearInterval(trickle.current);
      trickle.current = setInterval(() => setWidth((w) => (w < 90 ? w + (90 - w) * 0.12 : w)), 200);
    };

    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (...a: Parameters<typeof origPush>) { start(); return origPush.apply(this, a); };
    history.replaceState = function (...a: Parameters<typeof origReplace>) { start(); return origReplace.apply(this, a); };
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
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    // Wait until the route has actually settled (pathname differs from where the
    // navigation began) before considering completion.
    if (startPath.current !== null && pathname === startPath.current) return;
    // The route has changed but the destination may still be fetching — keep
    // trickling toward 90% until in-flight queries drain, then complete.
    if (fetching > 0) return;
    if (trickle.current) clearInterval(trickle.current);
    setWidth(100);
    hide.current = setTimeout(() => {
      setVisible(false);
      setWidth(0);
    }, 300);
    // Complete only once the resolved pathname has settled AND data is ready.
  }, [pathname, fetching, visible]);

  return (
    <div
      aria-hidden
      style={{ position: "fixed", insetInline: 0, top: 0, height: 2, zIndex: 80, pointerEvents: "none", opacity: visible ? 1 : 0, transition: "opacity 200ms var(--ease-out)" }}
    >
      <div style={{ height: "100%", width: `${width}%`, background: "var(--accent)", boxShadow: "0 0 8px var(--flame-300)", transition: "width 200ms var(--ease-out)" }} />
    </div>
  );
}
