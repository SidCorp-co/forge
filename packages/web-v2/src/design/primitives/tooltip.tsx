"use client";

import { useRef, useState, type ReactNode } from "react";
import { Popover } from "@/design/primitives/popover";

export interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom";
  /** ISS-700 — wrap the label at a 240px cap, for longer content (e.g. a
   *  failure reason). Without it the label keeps one line and wraps only where
   *  the viewport is narrower than that line. */
  multiline?: boolean;
}

/** Hover/focus tooltip, placed by Popover: kept inside the viewport and flipped
 *  to the other side of its trigger when the preferred one lacks room. */
export function Tooltip({ label, children, side = "top", multiline = false }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <span
      ref={anchor}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      <Popover
        open={open}
        anchor={anchor}
        placement={side}
        maxWidth={multiline ? 240 : undefined}
        role="tooltip"
        className={`forge-fade pointer-events-none w-max whitespace-normal rounded-md px-2 py-1 font-mono ${
          multiline ? "text-left" : ""
        }`}
        style={{
          fontSize: "var(--text-11)",
          color: "var(--fg-on-accent)",
          background: "var(--ink-900)",
          boxShadow: "var(--shadow-md)",
        }}
      >
        {label}
      </Popover>
    </span>
  );
}
