"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useRef,
} from "react";
import { cn } from "@/lib/utils/cn";
import { useScrollLock } from "@/design/hooks/use-scroll-lock";

export type PopoverPlacement =
  | "top" | "top-start" | "top-end"
  | "bottom" | "bottom-start" | "bottom-end"
  | "left" | "left-start" | "left-end"
  | "right" | "right-start" | "right-end";

const GUTTER = 8;

export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onDismiss?: () => void;
  placement?: PopoverPlacement;
  gap?: number;
  matchAnchorWidth?: boolean;
  maxHeight?: number;
  maxWidth?: number;
  lockScroll?: boolean;
  takesFocus?: boolean;
  panelRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

function splitPlacement(placement: PopoverPlacement) {
  const [side, edge] = placement.split("-") as ["top" | "bottom" | "left" | "right", "start" | "end" | undefined];
  return { side, align: edge ?? "center" } as const;
}

function cap(limit: number | undefined, available: string) {
  return limit === undefined ? `var(${available})` : `min(${limit}px, var(${available}))`;
}

export function Popover({
  open,
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
  role = takesFocus ? "dialog" : undefined,
  className,
  style,
  children,
  ...rest
}: PopoverProps) {
  const panel = useRef<HTMLDivElement | null>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  const setPanel = useCallback(
    (node: HTMLDivElement | null) => {
      panel.current = node;
      assignRef(panelRef, node);
    },
    [panelRef],
  );

  useScrollLock(open && lockScroll, [panel]);

  const { side, align } = splitPlacement(placement);
  const placed: CSSProperties = {
    maxHeight: cap(maxHeight, "--available-height"),
    maxWidth: cap(maxWidth, "--available-width"),
    ...(matchAnchorWidth ? { width: "var(--anchor-width)" } : null),
    overscrollBehavior: "contain",
    ...style,
  };

  return (
    <PopoverPrimitive.Root
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        if (next) return;
        const target = (details.event as Event | undefined)?.target;
        if (details.reason === "outside-press" && target instanceof Node && anchor.current?.contains(target)) return;
        dismissRef.current?.();
      }}
    >
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={anchor}
          side={side}
          align={align}
          sideOffset={gap}
          collisionPadding={GUTTER}
          positionMethod="fixed"
          className="isolate z-50 outline-none"
        >
          <PopoverPrimitive.Popup
            ref={setPanel}
            initialFocus={takesFocus}
            finalFocus={takesFocus ? anchor : false}
            {...rest}
            role={role}
            className={cn("outline-none", className)}
            style={placed}
          >
            {children}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
