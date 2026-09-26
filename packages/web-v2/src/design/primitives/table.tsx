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
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: HTMLAttributes<HTMLTableElement>) {
  const [scrollerRef, edges] = useScrollEdges<HTMLDivElement>();
  const overflows = edges.start || edges.end;
  const regionName = ariaLabelledBy
    ? { "aria-labelledby": ariaLabelledBy }
    : { "aria-label": ariaLabel ?? DEFAULT_REGION_NAME };
  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-surface has-[>[role=region]:focus-visible]:outline-2 has-[>[role=region]:focus-visible]:outline-offset-2 has-[>[role=region]:focus-visible]:outline-cobalt">
      <div
        ref={scrollerRef}
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
      <EdgeCue side="start" visible={edges.start} />
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
      className={cn("border-b border-line-subtle transition-colors last:border-0 hover:bg-hover", className)}
      {...props}
    />
  );
}

// Vertical padding follows the global density var (set on <html data-density>);
// horizontal padding stays fixed. Inline style wins over the utility's py so
// compact mode tightens rows everywhere the kit Table is used.
const DENSITY_PY = { paddingTop: "var(--density-row-py)", paddingBottom: "var(--density-row-py)" };

export function TH({ className, style, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn("fg-overline px-4 font-mono", className)} style={{ ...DENSITY_PY, ...style }} {...props} />;
}

export function TD({ className, style, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("fg-body-sm px-4 text-fg", className)} style={{ ...DENSITY_PY, ...style }} {...props} />;
}
