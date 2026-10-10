"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { HoverCardContent, HoverCardTrigger, HoverCard as Root } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils/cn";
import type { PopoverPlacement } from "../primitives/popover";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

const CLOSE_AFTER_MS = 140;

/**
 * For a canvas node that positions its own card (workflows' C4 nodes): detail that opens on hover or keyboard focus and stays while the pointer is on it; a click pins it
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

export interface HoverCardProps {
  /** What is always shown; it takes focus so the card opens from the keyboard too. */
  children: ReactNode;
  content: ReactNode;
  /** Names the card for assistive tech. */
  label: string;
  placement?: PopoverPlacement;
  className?: string;
  cardClassName?: string;
  "data-testid"?: string;
}

/** A trigger with a detail card on hover or focus (Base UI PreviewCard): the facts stay on the page, their detail behind them. */
export function HoverCard({ children, content, label, placement = "bottom-start", className, cardClassName, "data-testid": testId }: HoverCardProps) {
  const [side, align = "center"] = placement.split("-") as [Side, Align?];
  return (
    <Root>
      <HoverCardTrigger
        delay={200}
        closeDelay={CLOSE_AFTER_MS}
        render={<span tabIndex={0} />}
        className={cn("cursor-help rounded-xs outline-none focus-visible:shadow-focus", className)}
        data-testid={testId}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent side={side} align={align} aria-label={label} className={cn("w-auto max-w-sm bg-surface px-3.5 py-3 text-13 text-fg", cardClassName)}>
        {content}
      </HoverCardContent>
    </Root>
  );
}
