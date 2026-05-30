import type { ReactNode } from "react";
import { STAGES, type StageKey, stageColor } from "@/design/stages";

export interface KanbanColumnProps {
  /** Pipeline stage this column represents (drives the dot + default label). */
  stage: StageKey;
  /** Card count shown next to the label. */
  count: number;
  /** Cards (typically `KanbanCard`s). */
  children?: ReactNode;
  /** Empty-state hint; defaults to the stage description. */
  emptyHint?: string;
}

/** One kanban column — a fixed-width, internally-scrolling lane. A row of these
    inside `KanbanBoard` is the pipeline-as-kanban (issues flow left→right). */
export function KanbanColumn({ stage, count, children, emptyHint }: KanbanColumnProps) {
  const meta = STAGES.find((s) => s.key === stage);
  return (
    <section
      aria-label={meta?.label ?? stage}
      className="flex w-[248px] flex-none snap-start flex-col rounded-lg border border-line-subtle bg-sunken"
    >
      <header className="flex items-center gap-2 px-3.5 pb-2.5 pt-3">
        <span
          className="size-2.5 flex-none rounded-full"
          style={{ background: stageColor(stage) }}
        />
        <span className="font-mono text-[12.5px] font-semibold tracking-[0.01em] text-fg">
          {meta?.label ?? stage}
        </span>
        <span className="font-mono text-[11.5px] text-subtle">{count}</span>
      </header>
      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-2.5 pb-3 pt-0.5">
        {count === 0 ? (
          <span className="px-1 py-3.5 text-center text-[12px] italic text-disabled">
            {emptyHint ?? meta?.desc}
          </span>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
