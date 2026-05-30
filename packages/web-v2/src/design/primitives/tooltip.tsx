"use client";

import { useState, type ReactNode } from "react";

export interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom";
}

/** Lightweight hover/focus tooltip (CSS-positioned, no portal). */
export function Tooltip({ label, children, side = "top" }: TooltipProps) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className="forge-fade pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-1 font-mono"
          style={{
            fontSize: 11,
            color: "#fff",
            background: "var(--ink-900)",
            boxShadow: "var(--shadow-md)",
            bottom: side === "top" ? "calc(100% + 6px)" : undefined,
            top: side === "bottom" ? "calc(100% + 6px)" : undefined,
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
