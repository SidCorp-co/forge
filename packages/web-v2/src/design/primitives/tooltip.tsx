"use client";

import { useState, type ReactNode } from "react";

export interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom";
  /** ISS-700 — wrap the label onto multiple lines with a capped width instead
   *  of the default single-line `whitespace-nowrap`, for longer content (e.g.
   *  a failure reason) that would otherwise overflow at narrow viewports. */
  multiline?: boolean;
}

/** Lightweight hover/focus tooltip (CSS-positioned, no portal). */
export function Tooltip({ label, children, side = "top", multiline = false }: TooltipProps) {
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
          className={`forge-fade pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 rounded-md px-2 py-1 font-mono ${
            multiline ? "whitespace-normal text-left" : "whitespace-nowrap"
          }`}
          style={{
            fontSize: 11,
            color: "#fff",
            background: "var(--ink-900)",
            boxShadow: "var(--shadow-md)",
            bottom: side === "top" ? "calc(100% + 6px)" : undefined,
            top: side === "bottom" ? "calc(100% + 6px)" : undefined,
            maxWidth: multiline ? 240 : undefined,
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
