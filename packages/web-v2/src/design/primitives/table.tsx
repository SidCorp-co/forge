import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

/* Calm data table — borders do the structural work; rows hover to --bg-hover. */

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table className={cn("w-full border-collapse text-left", className)} {...props} />
    </div>
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
