import type { CSSProperties, HTMLAttributes } from "react";

// Every flexible track is minmax(0, …): a track that may not shrink below its content is what made the old table push the page sideways.
export const GRID =
  "grid grid-cols-[var(--sel)_minmax(0,1fr)_auto_auto_2.75rem] lg:grid-cols-[var(--sel)_5.5rem_minmax(0,1fr)_minmax(0,16rem)_5rem_2.25rem_2.25rem]";

export const CELL = {
  select: "col-start-1 row-start-1 row-span-3 self-start lg:row-span-1 lg:self-center",
  id: "col-start-2 row-start-1",
  title: "col-span-4 col-start-2 row-start-2 lg:col-span-1 lg:col-start-3 lg:row-start-1",
  state: "col-span-4 col-start-2 row-start-3 lg:col-span-1 lg:col-start-4 lg:row-start-1",
  priority: "col-start-3 row-start-1 lg:col-start-5",
  who: "col-start-4 row-start-1 lg:col-start-6",
  menu: "col-start-5 row-start-1 lg:col-start-7",
} as const;

export function gridStyle(selectable: boolean): CSSProperties {
  return { "--sel": selectable ? "2.25rem" : "0px" } as CSSProperties;
}

type GridRole = "table" | "rowgroup" | "row" | "columnheader" | "rowheader" | "cell";

// Divs, because a <table> lays out by min-content width; the role gives back the table reading.
export function GridPart({ role, ...props }: HTMLAttributes<HTMLDivElement> & { role: GridRole }) {
  return <div role={role} {...props} />;
}
