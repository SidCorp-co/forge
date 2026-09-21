import type { ReactNode } from "react";

export interface KanbanColumnProps {
  title: string;
  /** The column's dot, from the same semantic tone the cards' chips resolve through. */
  color: string;
  /** Card count shown next to the title. */
  count: number;
  /** Cards (typically `KanbanCard`s). */
  children?: ReactNode;
  emptyHint: string;
}

/** One kanban column — a fixed-width, internally-scrolling lane. */
export function KanbanColumn({ title, color, count, children, emptyHint }: KanbanColumnProps) {
  return (
    <section
      aria-label={title}
      className="flex w-[248px] flex-none snap-start flex-col rounded-lg border border-line-subtle bg-sunken"
    >
      <header className="flex items-center gap-2 px-3.5 pb-2.5 pt-3">
        <span className="size-2.5 flex-none rounded-full" style={{ background: color }} />
        <span className="font-mono text-12-5 font-semibold tracking-[0.01em] text-fg">
          {title}
        </span>
        <span className="font-mono text-11-5 text-subtle">{count}</span>
      </header>
      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-2.5 pb-3 pt-0.5">
        {count === 0 ? (
          <span className="px-1 py-3.5 text-center text-12 italic text-disabled">
            {emptyHint}
          </span>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
