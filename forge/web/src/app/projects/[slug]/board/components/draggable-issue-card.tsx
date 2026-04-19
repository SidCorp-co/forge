'use client';

import { cn } from '@/lib/utils/cn';
import { AgentStatusIndicator, PriorityBadge } from '@/components/ui';
import { DRAGGABLE_CARD_CLASS } from '../constants';
import type { Issue } from '@/features/issue/types';

interface DraggableIssueCardProps {
  issue: Issue;
  onSelect: (id: string) => void;
  highlight?: boolean;
}

export function DraggableIssueCard({ issue, onSelect, highlight }: DraggableIssueCardProps) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('issueId', issue.documentId);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onSelect(issue.documentId)}
      className={cn(DRAGGABLE_CARD_CLASS, highlight && 'ring-2 ring-info animate-highlight-fade')}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-tight">{issue.title}</p>
        <AgentStatusIndicator status={issue.agentStatus} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {issue.priority && issue.priority !== 'none' && (
          <PriorityBadge priority={issue.priority} />
        )}
      </div>
    </div>
  );
}
