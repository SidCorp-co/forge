"use client";

import { type HTMLAttributes, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { Popover, type PopoverPlacement } from "../primitives/popover";

const CLOSE_AFTER_MS = 140;

/**
 * Detail that opens on hover or keyboard focus and stays while the pointer is on it; a click pins it
 * until a press outside or Escape. The trigger and the card share one timer, so moving from one to the
 * other does not close it.
 */
export function useHoverCard() {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const show = useCallback(() => {
    cancel();
    setOpen(true);
  }, [cancel]);
  const hide = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => {
      setOpen(false);
      setPinned(false);
    }, CLOSE_AFTER_MS);
  }, [cancel]);
  const close = useCallback(() => {
    cancel();
    setOpen(false);
    setPinned(false);
  }, [cancel]);
  useEffect(() => cancel, [cancel]);
  const leave = () => {
    if (!pinned) hide();
  };
  return {
    open,
    pinned,
    close,
    pin: () => {
      cancel();
      setOpen(true);
      setPinned(true);
    },
    /** Spread on the trigger. */
    trigger: { onMouseEnter: show, onMouseLeave: leave, onFocus: show, onBlur: leave },
    /** Spread on the card, so the pointer can move onto it. */
    card: { onMouseEnter: cancel, onMouseLeave: leave },
  };
}

export interface HoverCardProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children" | "content"> {
  /** What is always shown; it takes focus so the card opens from the keyboard too. */
  children: ReactNode;
  content: ReactNode;
  /** Names the card for assistive tech. */
  label: string;
  placement?: PopoverPlacement;
  cardClassName?: string;
}

/** A trigger with a detail card on hover, focus or click: the facts stay on the page, their detail behind them. */
export function HoverCard({ children, content, label, placement = "bottom-start", className, cardClassName, ...rest }: HoverCardProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const h = useHoverCard();
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: the trigger wraps arbitrary content and only discloses detail; a <button> would nest interactive content */}
      <span
        ref={anchor}
        role="button"
        tabIndex={0}
        aria-expanded={h.open}
        aria-haspopup="dialog"
        className={cn("cursor-help rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent", className)}
        onClick={() => (h.pinned ? h.close() : h.pin())}
        onKeyDown={(e) => {
          if (e.key === "Escape") h.close();
          else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            h.pinned ? h.close() : h.pin();
          }
        }}
        {...h.trigger}
        {...rest}
      >
        {children}
      </span>
      <Popover
        open={h.open}
        anchor={anchor}
        onDismiss={h.close}
        placement={placement}
        role="dialog"
        aria-label={label}
        maxWidth={360}
        className={cn("rounded-lg border border-line bg-surface px-3.5 py-3 text-13 shadow-lg", cardClassName)}
        {...h.card}
      >
        {content}
      </Popover>
    </>
  );
}
