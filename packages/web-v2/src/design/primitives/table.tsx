"use client";

import {
  type ComponentProps,
  type CSSProperties,
  type HTMLAttributes,
  type RefObject,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
  useCallback,
} from "react";
import { useScrollEdges } from "@/design/hooks/use-scroll-edges";
import { cn } from "@/lib/utils/cn";

/* Flush on what it rests on: hairlines divide header and rows, no frame, corner or fill; the opaque
   parts (sticky cell, stuck header, edge cues) paint the page's background, or a card's on `surface`. */

const DEFAULT_REGION_NAME = "Table, scrolls sideways";
const BOUNDED_REGION_NAME = "Table, scrolls";

const BOUNDED_FRAME = "max-h-[min(70vh,40rem)] overflow-y-auto";

/**
 * The scroller is exactly the frame's width and owns horizontal overflow. `contain: inline-size` keeps
 * the table's min-content width out of every ancestor's sizing, and `relative` makes the scroller the
 * containing block of absolutely positioned cells (an `sr-only` header) so they scroll with it
 * instead of widening the document. The focus ring is the frame's, the edge cues sitting over the
 * scroller's own edges.
 */
export function Table({
  className,
  stickyStart = false,
  bounded = false,
  surface = false,
  scrollerRef: outerRef,
  scrollerProps,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: HTMLAttributes<HTMLTableElement> & {
  /** The first column is `sticky`: the start cue gives way to the hairline its cells draw. */
  stickyStart?: boolean;
  /** A height of its own, which a windowed table needs to know what is in view; it is a tab stop. */
  bounded?: boolean;
  /** It rests inside a card, so its opaque parts paint the card's surface, not the page. */
  surface?: boolean;
  /** The scroller element, for a table that windows its rows by what the scroller shows. */
  scrollerRef?: RefObject<HTMLDivElement | null>;
  scrollerProps?: Pick<HTMLAttributes<HTMLDivElement>, "onFocus" | "onBlur">;
}) {
  const [edgesRef, edges] = useScrollEdges<HTMLDivElement>();
  const scrollerRef = useCallback(
    (node: HTMLDivElement | null) => {
      edgesRef.current = node;
      if (outerRef) outerRef.current = node;
    },
    [edgesRef, outerRef],
  );
  const overflows = edges.start || edges.end || bounded;
  const regionName = ariaLabelledBy
    ? { "aria-labelledby": ariaLabelledBy }
    : { "aria-label": ariaLabel ?? (bounded ? BOUNDED_REGION_NAME : DEFAULT_REGION_NAME) };
  return (
    <div
      data-table-on={surface ? "surface" : "page"}
      className="relative overflow-hidden border-b border-line has-[>[role=region]:focus-visible]:outline-2 has-[>[role=region]:focus-visible]:outline-offset-2 has-[>[role=region]:focus-visible]:outline-cobalt"
    >
      <div
        ref={scrollerRef}
        data-edge-start={edges.start}
        className={cn("relative overflow-x-auto [contain:inline-size] focus-visible:shadow-none", bounded && BOUNDED_FRAME)}
        {...scrollerProps}
        {...(overflows ? { role: "region", tabIndex: 0, ...regionName } : {})}
      >
        <table
          className={cn("w-full border-collapse text-left", className)}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          {...props}
        />
      </div>
      <EdgeCue side="start" visible={edges.start && !stickyStart} surface={surface} />
      <EdgeCue side="end" visible={edges.end} surface={surface} />
    </div>
  );
}

function EdgeCue({ side, visible, surface }: { side: "start" | "end"; visible: boolean; surface: boolean }) {
  const fill = surface ? "var(--bg-surface)" : "var(--bg-app)";
  return (
    <span
      aria-hidden
      data-table-edge={side}
      data-visible={visible}
      className={cn(
        "pointer-events-none absolute inset-y-0 w-8 opacity-0 motion-safe:transition-opacity data-[visible=true]:opacity-100",
        side === "start"
          ? "left-0 bg-[linear-gradient(to_right,var(--scrim),transparent_10px),linear-gradient(to_right,var(--cue-fill),transparent)]"
          : "right-0 bg-[linear-gradient(to_left,var(--scrim),transparent_10px),linear-gradient(to_left,var(--cue-fill),transparent)]",
      )}
      style={{ "--cue-fill": fill } as CSSProperties}
    />
  );
}

// The hairline is a pseudo-element because a collapsed table's cell border stays behind when it sticks.
const STUCK_HEAD =
  "[&_th]:sticky [&_th]:top-0 [&_th]:z-[2] [&_th]:bg-app in-data-[table-on=surface]:[&_th]:bg-surface [&_th]:after:absolute [&_th]:after:inset-x-0 [&_th]:after:bottom-0 [&_th]:after:h-px [&_th]:after:bg-line [&_th]:after:content-['']";

export function THead({ className, stuck = false, ...props }: HTMLAttributes<HTMLTableSectionElement> & { stuck?: boolean }) {
  return <thead className={cn("border-b border-line", stuck && STUCK_HEAD, className)} {...props} />;
}

export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export function TR({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn("group/row border-b border-line-subtle transition-colors last:border-0 hover:bg-hover", className)}
      {...props}
    />
  );
}

// Vertical padding follows the global density var (set on <html data-density>);
// horizontal padding stays fixed. Inline style wins over the utility's py so
// compact mode tightens rows everywhere the kit Table is used.
const DENSITY_PY = { paddingTop: "var(--density-row-py)", paddingBottom: "var(--density-row-py)" };

// Opaque, so the row scrolls out of sight under it; floor and cap keep it from taking the width the
// other columns need on a phone. A name longer than the cap is cut by `Truncated`, never broken mid-word.
const STICKY =
  "sticky left-0 z-[1] min-w-32 max-w-40 bg-app in-data-[table-on=surface]:bg-surface sm:max-w-72 in-data-[edge-start=true]:shadow-[1px_0_0_var(--color-line)]";

interface StickyCell {
  sticky?: boolean;
}

export function TH({ className, style, sticky, ...props }: ThHTMLAttributes<HTMLTableCellElement> & StickyCell) {
  return (
    <th
      className={cn("fg-overline px-4 font-mono", sticky && STICKY, className)}
      style={{ ...DENSITY_PY, ...style }}
      {...props}
    />
  );
}

export function TD({ className, style, sticky, ...props }: TdHTMLAttributes<HTMLTableCellElement> & StickyCell) {
  return (
    <td className={cn("fg-body-sm px-4 text-fg", sticky && `${STICKY} group-hover/row:bg-hover`, className)} style={{ ...DENSITY_PY, ...style }} {...props} />
  );
}
