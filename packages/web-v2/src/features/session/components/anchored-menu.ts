"use client";


import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

export interface MenuPosition {
  /** Set for `below` placement. */
  top?: number;
  /** Set for `above` placement — distance from the viewport bottom. */
  bottom?: number;
  left: number;
  width: number;
}

export interface AnchoredMenuOpts {
  open: boolean;
  onClose: () => void;
  /** The wrapper the panel is anchored to and that click-away must exclude. */
  anchorRef: RefObject<HTMLElement | null>;
  panelRef?: RefObject<HTMLElement | null>;
  /** Desired panel width; clamped to the viewport minus a gutter. */
  width?: number;
  /** `above` opens upward — the composer sits at the bottom of the screen. */
  placement?: "below" | "above";
}

const GUTTER = 12;
const OFFSET = 6;

/**
 * Viewport-fixed placement against `anchorRef`, plus Escape and click-away
 * dismissal. Returns null until the first measurement so the caller can render
 * the panel hidden rather than flashing it at 0,0.
 */
export function useAnchoredMenu({
  open,
  onClose,
  anchorRef,
  panelRef,
  width = 300,
  placement = "below",
}: AnchoredMenuOpts): MenuPosition | null {
  const [pos, setPos] = useState<MenuPosition | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      const anchor = anchorRef.current;
      if (!anchor) return;
      if (anchor.contains(target)) return;
      if (panelRef?.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef, panelRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const w = Math.min(width, vw - GUTTER * 2);
      const left = Math.min(Math.max(r.right - w, GUTTER), Math.max(vw - GUTTER - w, GUTTER));
      setPos(
        placement === "above"
          ? { bottom: Math.max(GUTTER, window.innerHeight - r.top + OFFSET), left, width: w }
          : { top: r.bottom + OFFSET, left, width: w },
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, width, placement]);

  return pos;
}
