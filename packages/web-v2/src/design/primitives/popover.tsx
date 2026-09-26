"use client";

// The one file importing @floating-ui/react (biome.json's noRestrictedImports);
// nothing of the library's type leaves it, so its next major costs this file.

import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  shift,
  size,
  useFloating,
} from "@floating-ui/react";
import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { cn } from "@/lib/utils/cn";
import { useScrollLock } from "@/design/hooks/use-scroll-lock";

export type PopoverPlacement =
  | "top" | "top-start" | "top-end"
  | "bottom" | "bottom-start" | "bottom-end"
  | "left" | "left-start" | "left-end"
  | "right" | "right-start" | "right-end";

/** Distance kept from the viewport edge when a panel is shifted or capped. */
const GUTTER = 8;
const FOCUSABLE = 'button:not([disabled]),a[href],input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

/*
 * Stacking, stated once. Every layer below renders through a portal on <body>,
 * so none sits inside another's stacking context and z-index alone orders them:
 *   z-50    anchored panels (Popover) and the dialog layer (SlideOver, ConfirmDialog);
 *           among equals the later portal wins, and a panel opens after what opened it
 *   z-[55]  the command palette (Layer tier "palette")
 *   z-[60]  toasts and the image lightbox
 */
const TIER = { panel: "z-50", palette: "z-[55]" } as const;

export interface LayerProps {
  tier?: keyof typeof TIER;
  children: ReactNode;
}

/** A portal onto <body> at a stacking tier, for a surface with no anchor. */
export function Layer({ tier = "panel", children }: LayerProps) {
  return (
    <FloatingPortal>
      <div className={cn("relative", TIER[tier])}>{children}</div>
    </FloatingPortal>
  );
}

export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  open: boolean;
  /** The element the panel is placed against. */
  anchor: RefObject<HTMLElement | null>;
  /** A press outside anchor and panel; omitted, only the owner closes it. */
  onDismiss?: () => void;
  /** The preferred side; the panel flips when it lacks room there. */
  placement?: PopoverPlacement;
  gap?: number;
  matchAnchorWidth?: boolean;
  /** Caps on top of the room the viewport leaves; the panel scrolls inside. */
  maxHeight?: number;
  maxWidth?: number;
  /** Hold the page still while open; wheel and touch still scroll inside the panel. */
  lockScroll?: boolean;
  /** Move focus into the panel on open and back to the anchor on close, with Tab
   *  continuing from the anchor as though the panel sat beside it; focus leaving
   *  the panel dismisses it. For panels a keyboard user works inside. */
  takesFocus?: boolean;
  panelRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

/**
 * A panel placed against an anchor: rendered through a portal at
 * `position: fixed`, so no clipping ancestor cuts it; flipped to the other side
 * when the preferred one lacks room; shifted and capped to stay in the
 * viewport; kept on its anchor while anything scrolls or resizes.
 */
export function Popover(props: PopoverProps) {
  if (!props.open) return null;
  return <OpenPopover {...props} />;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

function OpenPopover({
  open: _open,
  anchor,
  onDismiss,
  placement = "bottom-start",
  gap = 6,
  matchAnchorWidth = false,
  maxHeight,
  maxWidth,
  lockScroll = false,
  takesFocus = false,
  panelRef,
  className,
  style,
  children,
  ...rest
}: PopoverProps) {
  const panel = useRef<HTMLDivElement | null>(null);
  const caps = useRef({ maxHeight, maxWidth, matchAnchorWidth });
  caps.current = { maxHeight, maxWidth, matchAnchorWidth };

  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const { refs, floatingStyles, isPositioned, context } = useFloating({
    open: true,
    onOpenChange: (next) => {
      if (!next) dismissRef.current?.();
    },
    placement,
    strategy: "fixed",
    elements: { reference: anchor.current },
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(gap),
      flip({ padding: GUTTER }),
      shift({ padding: GUTTER }),
      size({
        padding: GUTTER,
        apply({ availableHeight, availableWidth, rects, elements }) {
          const cap = caps.current;
          const height = Math.max(0, Math.min(cap.maxHeight ?? Infinity, availableHeight));
          const width = Math.max(0, Math.min(cap.maxWidth ?? Infinity, availableWidth));
          Object.assign(elements.floating.style, {
            maxHeight: `${height}px`,
            maxWidth: `${width}px`,
            ...(cap.matchAnchorWidth ? { width: `${rects.reference.width}px` } : {}),
          });
        },
      }),
    ],
  });

  const setPanel = useCallback(
    (node: HTMLDivElement | null) => {
      panel.current = node;
      refs.setFloating(node);
      assignRef(panelRef, node);
    },
    [refs, panelRef],
  );

  const dismissible = onDismiss !== undefined;
  useEffect(() => {
    if (!dismissible) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      dismissRef.current?.();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [dismissible, anchor]);

  useScrollLock(lockScroll, [panel]);

  const placed: CSSProperties = {
    ...floatingStyles,
    ...(isPositioned ? null : { opacity: 0 }),
    overscrollBehavior: "contain",
    ...style,
  };

  const returnTo = useRef<HTMLElement | null>(null);
  const home = anchor.current;
  returnTo.current = home?.matches(FOCUSABLE) ? home : (home?.querySelector<HTMLElement>(FOCUSABLE) ?? null);

  const node = (
    <div ref={setPanel} {...rest} className={cn(TIER.panel, className)} style={placed}>
      {children}
    </div>
  );
  return (
    <FloatingPortal>
      {takesFocus ? (
        <FloatingFocusManager context={context} modal={false} returnFocus={returnTo}>
          {node}
        </FloatingFocusManager>
      ) : (
        node
      )}
    </FloatingPortal>
  );
}
