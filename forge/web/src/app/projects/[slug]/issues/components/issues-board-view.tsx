'use client';

import { cn } from '@/lib/utils/cn';
import { BOARD_COLUMNS } from '../constants';
import { BoardCard } from './board-card';
import type { Issue } from '@/features/issue/types';

interface IssuesBoardViewProps {
  filtered: Issue[];
  onUpdate: (id: string, data: Partial<Issue>) => void;
  onSelect: (id: string) => void;
}

export function IssuesBoardView({ filtered, onUpdate, onSelect }: IssuesBoardViewProps) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-4 lg:grid lg:grid-cols-5 lg:overflow-x-visible">
      {BOARD_COLUMNS.map((col) => {
        const colIssues = filtered.filter((i) => col.statuses.includes(i.status));
        return (
          <div
            key={col.key}
            className={cn('min-w-[180px] flex-1 rounded-sm border-t-2 p-3', col.color, col.bg)}
          >
            <h3 className="mb-3 flex items-center justify-between text-sm font-semibold text-primary">
              {col.label}
              <span className="rounded-sm bg-surface-container-high px-2 py-0.5 text-xs font-normal text-outline">
                {colIssues.length}
              </span>
            </h3>
            <div className="space-y-2">
              {colIssues.map((issue) => (
                <BoardCard key={issue.id} issue={issue} onUpdate={onUpdate} onSelect={onSelect} />
              ))}
              {colIssues.length === 0 && (
                <p className="py-8 text-center text-xs text-outline-variant">No issues</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
