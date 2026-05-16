'use client';

import { cn } from '@/lib/utils/cn';
import { AgentStatusIndicator, PriorityBadge } from '@/components/ui';
import { DRAGGABLE_CARD_CLASS, type BoardDensity } from '../constants';
import type { Issue } from '@/features/issue/types';

interface DraggableIssueCardProps {
  issue: Issue;
  onSelect: (id: string) => void;
  highlight?: boolean;
  density?: BoardDensity;
}

export function DraggableIssueCard({
  issue,
  onSelect,
  highlight,
  density = 'comfortable',
}: DraggableIssueCardProps) {
  const compact = density === 'compact';
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('issueId', issue.documentId);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onSelect(issue.documentId)}
      className={cn(
        DRAGGABLE_CARD_CLASS,
        compact && 'p-2',
        highlight && 'ring-2 ring-info animate-highlight-fade',
      )}
    >
      {issue.displayId && (
        <div
          className={cn(
            'font-mono text-[10px] tracking-widest text-primary-fixed',
            compact ? 'mb-0.5' : 'mb-1',
          )}
        >
          {issue.displayId}
        </div>
      )}
      <div className="flex items-start justify-between gap-2">
        <p className={cn('font-medium leading-tight', compact ? 'text-xs' : 'text-sm')}>
          {issue.title}
        </p>
        {!compact && <AgentStatusIndicator status={issue.agentStatus} />}
      </div>
      {!compact && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {issue.priority && issue.priority !== 'none' && (
            <PriorityBadge priority={issue.priority} />
          )}
        </div>
      )}
    </div>
  );
}
