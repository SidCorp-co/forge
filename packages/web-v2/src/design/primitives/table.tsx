"use client";

import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { useScrollEdges } from "@/design/hooks/use-scroll-edges";
import { cn } from "@/lib/utils/cn";

/* Calm data table — borders do the structural work; rows hover to --bg-hover. */

const DEFAULT_REGION_NAME = "Table, scrolls sideways";

/**
 * The card clips only its corners; the scroller inside it is exactly its width
 * and owns horizontal overflow. `contain: inline-size` keeps the table's
 * min-content width out of every ancestor's sizing, and `relative` makes the
 * scroller the containing block of absolutely positioned cells (an `sr-only`
 * header) so they scroll with it instead of widening the document. The focus
 * ring is the card's, since the edge cues sit over the scroller's own edges.
 */
export function Table({
  className,
  stickyStart = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: HTMLAttributes<HTMLTableElement> & {
  /** The first column is `sticky`: the start cue gives way to the hairline its cells draw. */
  stickyStart?: boolean;
}) {
  const [scrollerRef, edges] = useScrollEdges<HTMLDivElement>();
  const overflows = edges.start || edges.end;
  const regionName = ariaLabelledBy
    ? { "aria-labelledby": ariaLabelledBy }
    : { "aria-label": ariaLabel ?? DEFAULT_REGION_NAME };
  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-surface has-[>[role=region]:focus-visible]:outline-2 has-[>[role=region]:focus-visible]:outline-offset-2 has-[>[role=region]:focus-visible]:outline-cobalt">
      <div
        ref={scrollerRef}
        data-edge-start={edges.start}
        className="relative overflow-x-auto [contain:inline-size] focus-visible:shadow-none"
        {...(overflows ? { role: "region", tabIndex: 0, ...regionName } : {})}
      >
        <table
          className={cn("w-full border-collapse text-left", className)}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          {...props}
        />
      </div>
      <EdgeCue side="start" visible={edges.start && !stickyStart} />
      <EdgeCue side="end" visible={edges.end} />
    </div>
  );
}

function EdgeCue({ side, visible }: { side: "start" | "end"; visible: boolean }) {
  return (
    <span
      aria-hidden
      data-table-edge={side}
      data-visible={visible}
      className={cn(
        "pointer-events-none absolute inset-y-0 w-8 opacity-0 motion-safe:transition-opacity data-[visible=true]:opacity-100",
        side === "start"
          ? "left-0 bg-[linear-gradient(to_right,var(--scrim),transparent_10px),linear-gradient(to_right,var(--bg-surface),transparent)]"
          : "right-0 bg-[linear-gradient(to_left,var(--scrim),transparent_10px),linear-gradient(to_left,var(--bg-surface),transparent)]",
      )}
    />
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-line", className)} {...props} />;
}

export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
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
  "sticky left-0 z-[1] min-w-32 max-w-40 bg-surface sm:max-w-72 in-data-[edge-start=true]:shadow-[1px_0_0_var(--color-line)]";

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
