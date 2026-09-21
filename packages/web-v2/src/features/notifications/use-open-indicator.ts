"use client";

import { useEffect } from "react";
import { setFaviconBadge, setTitleOpenCount } from "@/lib/notifications/favicon";

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
