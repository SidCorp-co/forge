"use client";

// Placement + dismissal for the composer's two small anchored popovers
// (ISS-718). Extracted from the behaviour `runner-picker.tsx` and
// `conversation-list.tsx` already implement by hand so the model picker and the
// slash menu cannot drift from it — a popover that spills off a 375px screen, or
// that Escape does not close, is the failure this hook exists to prevent.

import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

export interface MenuPosition {
  top: number;
  left: number;
  width: number;
}

export interface AnchoredMenuOpts {
  open: boolean;
  onClose: () => void;
  /** The wrapper the panel is anchored to and that click-away must exclude. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Desired panel width; clamped to the viewport minus a gutter. */
  width?: number;
  /** `above` opens upward — the composer sits at the bottom of the screen. */
  placement?: "below" | "above";
  /** Panel height used when placing upward (a max; the panel may be shorter). */
  maxHeight?: number;
}

const GUTTER = 12;

/**
 * Viewport-fixed placement under (or over) `anchorRef`, plus Escape and
 * click-away dismissal. Returns null until the first measurement so the caller
 * can render the panel hidden rather than flashing it at 0,0.
 */
export function useAnchoredMenu({
  open,
  onClose,
  anchorRef,
  width = 300,
  placement = "below",
  maxHeight = 320,
}: AnchoredMenuOpts): MenuPosition | null {
  const [pos, setPos] = useState<MenuPosition | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const anchor = anchorRef.current;
      if (anchor && !anchor.contains(e.target as Node)) onClose();
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
  }, [open, onClose, anchorRef]);

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
      // cm:why right-align to the anchor, then clamp BOTH edges — at 375px a right-aligned panel of the desired width starts off-screen, so clamping only the left edge is not enough
      const left = Math.min(Math.max(r.right - w, GUTTER), Math.max(vw - GUTTER - w, GUTTER));
      const above = placement === "above";
      const top = above ? Math.max(GUTTER, r.top - 6 - maxHeight) : r.bottom + 6;
      setPos({ top, left, width: w });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, width, placement, maxHeight]);

  return pos;
}
