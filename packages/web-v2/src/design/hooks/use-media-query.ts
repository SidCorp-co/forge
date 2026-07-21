"use client";

import { useEffect, useState } from "react";

/** SSR-safe media query match — defaults to `false` on the server / first
    client render, then syncs to `window.matchMedia(query)` and stays live. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
