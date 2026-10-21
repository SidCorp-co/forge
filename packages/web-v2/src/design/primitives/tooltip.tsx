"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Popover } from "@/design/primitives/popover";

export interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom";
  /** ISS-700 — wrap the label at a 240px cap, for longer content (e.g. a
   *  failure reason). Without it the label keeps one line and wraps only where
   *  the viewport is narrower than that line. */
  multiline?: boolean;
  /** ISS-1229 r28 — a sentence a person reads, set in the app's text face and wrapped at the
   *  multiline cap; the code face stays for identifiers and short labels. A touch screen has no
   *  hover, so a tap on the trigger shows it too, and only a tap anywhere else or Escape puts it away:
   *  the mouseleave a touch browser sends after the tap's click does not (r30, judge-86). */
  prose?: boolean;
}

export interface TooltipPanelProps extends Pick<TooltipProps, "label" | "side" | "multiline" | "prose"> {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
}

/** The bubble a Tooltip draws, for a trigger that cannot sit inside a Tooltip's wrapper. */
export function TooltipPanel({
  open,
  anchor,
  label,
  side = "top",
  multiline = false,
  prose = false,
}: TooltipPanelProps) {
  const wraps = multiline || prose;
  return (
    <Popover
      open={open}
      anchor={anchor}
      placement={side}
      maxWidth={wraps ? 240 : undefined}
      role="tooltip"
      className={`forge-fade pointer-events-none w-max whitespace-normal rounded-md px-2 py-1 ${
        prose ? "font-sans leading-snug" : "font-mono"
      } ${wraps ? "text-left" : ""}`}
      style={{
        fontSize: prose ? "var(--text-12)" : "var(--text-11)",
        color: "var(--fg-on-accent)",
        background: "var(--ink-900)",
        boxShadow: "var(--shadow-md)",
      }}
    >
      {label}
    </Popover>
  );
}

/** Hover/focus tooltip, placed by Popover: kept inside the viewport and flipped
 *  to the other side of its trigger when the preferred one lacks room. */
export function Tooltip({ label, children, side = "top", multiline = false, prose = false }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  // Opened by a finger, so only a tap elsewhere, a blur or Escape closes it, never an emulated mouse.
  const byTouch = useRef(false);
  const close = useCallback(() => {
    byTouch.current = false;
    setOpen(false);
  }, []);
  const openByTouch = useCallback(() => {
    byTouch.current = true;
    setOpen(true);
  }, []);
  useEffect(() => {
    if (!open || !prose) return;
    const away = (e: Event) => {
      if (!anchor.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("touchstart", away);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("touchstart", away);
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, prose, close]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the span only relays hover, focus and touch from the control it wraps, which is what a reader acts on; it is not a control itself.
    <span
      ref={anchor}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!byTouch.current) close();
      }}
      onFocus={() => setOpen(true)}
      onBlur={close}
      onPointerDown={
        prose
          ? (e) => {
              if (e.pointerType !== "mouse") openByTouch();
            }
          : undefined
      }
      onTouchEnd={prose ? openByTouch : undefined}
    >
      {children}
      <TooltipPanel open={open} anchor={anchor} label={label} side={side} multiline={multiline} prose={prose} />
    </span>
  );
}
