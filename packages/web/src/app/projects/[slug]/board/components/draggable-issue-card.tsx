'use client';

import { cn } from '@/lib/utils/cn';
import { PriorityBadge } from '@/components/ui';
import { AgentQueueBadge, pickActiveSession } from '@/components/issue/agent-queue-badge';
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
      {issue.displayId && (
        <div className="mb-1 font-mono text-[10px] tracking-widest text-primary-fixed">
          {issue.displayId}
        </div>
      )}
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-tight">{issue.title}</p>
        <AgentQueueBadge
          session={pickActiveSession(issue.agentSessions)}
          agentStatus={issue.agentStatus}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {issue.priority && issue.priority !== 'none' && (
          <PriorityBadge priority={issue.priority} />
        )}
      </div>
    </div>
  );
}
