'use client';

import type { Issue } from '@forge/contracts';
import { InlinePrioritySelect } from '@/components/issue/inline-priority-select';
import { InlineStatusSelect } from '@/components/issue/inline-status-select';
import type { IssuePriority, IssueStatus } from '@/features/issue/types';

interface BoardCardProps {
  issue: Issue;
  onUpdate: (id: string, data: { status?: IssueStatus; priority?: IssuePriority }) => void;
  onSelect: (id: string) => void;
}

export function BoardCard({ issue, onUpdate, onSelect }: BoardCardProps) {
  return (
    <div className="rounded-sm border border-outline-variant/20 bg-surface-container-low p-3 transition-colors hover:bg-surface-container-high">
      <button
        onClick={() => onSelect(issue.id)}
        className="block text-left text-sm font-medium text-on-surface hover:text-on-surface focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-outline rounded-sm"
      >
        <span className="mr-1 font-mono text-[10px] text-primary-fixed">{issue.displayId}</span>
        {issue.title}
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <InlinePrioritySelect issue={issue} onUpdate={onUpdate} />
        <InlineStatusSelect issue={issue} onUpdate={(id, data) => onUpdate(id, data)} />
      </div>
    </div>
  );
}
