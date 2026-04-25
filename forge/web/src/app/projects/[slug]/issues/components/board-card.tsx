'use client';

import { AgentRunningDot } from '@/components/ui';
import { InlinePrioritySelect } from '@/components/issue/inline-priority-select';
import { InlineStatusSelect } from '@/components/issue/inline-status-select';
import type { Issue } from '@/features/issue/types';

interface BoardCardProps {
  issue: Issue;
  onUpdate: (id: string, data: Partial<Issue>) => void;
  onSelect: (id: string) => void;
}

export function BoardCard({ issue, onUpdate, onSelect }: BoardCardProps) {
  return (
    <div className="rounded-sm border border-outline-variant/20 bg-surface-container-low p-3 transition-colors hover:bg-surface-container-high">
      <button
        onClick={() => onSelect(issue.documentId)}
        className="block text-left text-sm font-medium text-on-surface hover:text-on-surface focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-outline rounded-sm"
      >
        <span className="mr-1 font-mono text-[10px] text-primary-fixed">{issue.displayId ?? `ISS-${issue.id}`}</span>
        {issue.title}
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <InlinePrioritySelect issue={issue} onUpdate={onUpdate} />
        <InlineStatusSelect issue={issue} onUpdate={onUpdate} />
      </div>
      {issue.agentStatus && issue.agentStatus !== 'idle' && (
        <div className="mt-1.5 flex items-center gap-1 text-[10px] text-secondary-dim">
          {issue.agentStatus === 'running' && <AgentRunningDot size="sm" />}
          {issue.agentStatus}
        </div>
      )}
    </div>
  );
}
