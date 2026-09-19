import type { ReactNode } from "react";

export interface KanbanBoardProps {
  /** Columns (`KanbanColumn`s). */
  children: ReactNode;
}

export function KanbanBoard({ children }: KanbanBoardProps) {
  return (
    <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
      <div className="flex h-full min-w-min snap-x snap-mandatory gap-3.5 px-1 pb-1">
        {children}
      </div>
    </div>
  );
}
