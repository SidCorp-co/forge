"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface HighlightProps {
  /** Change this (e.g. an updatedAt / status) to flash the wrapped content. */
  trigger: unknown;
  children: ReactNode;
  className?: string;
}

/** Flashes its children once (accent-tint → transparent) whenever `trigger`
    changes — draws the eye to a row that just updated over WebSocket. */
export function Highlight({ trigger, children, className }: HighlightProps) {
  const [on, setOn] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setOn(true);
    const t = setTimeout(() => setOn(false), 1200);
    return () => clearTimeout(t);
  }, [trigger]);

  return <div className={cn(on && "forge-highlight", className)}>{children}</div>;
}
