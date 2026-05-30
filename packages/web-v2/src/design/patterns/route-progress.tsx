"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/** Top flame progress bar during client navigations — lib-free. Starts on
    link click / history change, trickles to ~90%, completes when the new
    pathname settles. In-page hash links are ignored. Mount once in layout. */
export function RouteProgress() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const trickle = useRef<ReturnType<typeof setInterval> | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const start = () => {
      if (hide.current) clearTimeout(hide.current);
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
    if (trickle.current) clearInterval(trickle.current);
    setWidth(100);
    hide.current = setTimeout(() => {
      setVisible(false);
      setWidth(0);
    }, 300);
    // run only when the resolved pathname changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <div
      aria-hidden
      style={{ position: "fixed", insetInline: 0, top: 0, height: 2, zIndex: 80, pointerEvents: "none", opacity: visible ? 1 : 0, transition: "opacity 200ms var(--ease-out)" }}
    >
      <div style={{ height: "100%", width: `${width}%`, background: "var(--accent)", boxShadow: "0 0 8px var(--flame-300)", transition: "width 200ms var(--ease-out)" }} />
    </div>
  );
}
