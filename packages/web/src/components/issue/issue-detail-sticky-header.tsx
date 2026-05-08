'use client';

import { useEffect, useState, type RefObject } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import type { Issue, IssuePatchInput } from '@forge/contracts';
import type { IssueStatus } from '@/features/issue/types';
import type { ProjectMemberRow } from '@/features/project/hooks/use-project-members';
import { AssigneePicker } from './assignee-picker';
import { InlineStatusSelect } from './inline-status-select';
import { InlinePrioritySelect } from './inline-priority-select';
import { cn } from '@/lib/utils/cn';

interface ManualHoldToggleProps {
  value: boolean;
  pending: boolean;
  onToggle: (next: boolean) => void;
  compact?: boolean;
}

export function ManualHoldToggle({
  value,
  pending,
  onToggle,
  compact = false,
}: ManualHoldToggleProps) {
  const base =
    'inline-flex items-center gap-1 rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-widest transition-colors disabled:opacity-50';
  const onCls = 'border-amber-500/40 bg-amber-500/15 text-amber-400 hover:bg-amber-500/25';
  const offCls =
    'border-outline-variant/30 bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest';
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => onToggle(!value)}
      className={cn(base, value ? onCls : offCls)}
      title={value ? 'Manual hold ON — click to release' : 'Click to set manual hold'}
      aria-pressed={value}
      aria-label={value ? 'Release manual hold' : 'Set manual hold'}
    >
      {value ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
      {!compact && (value ? 'Held' : 'Hold')}
    </button>
  );
}

interface Props {
  issue: Issue;
  members: ProjectMemberRow[];
  sentinelRef: RefObject<HTMLDivElement | null>;
  onStatusUpdate: (id: string, data: { status: IssueStatus }) => void;
  onPatch: (id: string, patch: IssuePatchInput) => void;
  onManualHoldToggle: (next: boolean) => void;
  manualHoldPending: boolean;
}

export function IssueDetailStickyHeader({
  issue,
  members,
  sentinelRef,
  onStatusUpdate,
  onPatch,
  onManualHoldToggle,
  manualHoldPending,
}: Props) {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      ([entry]) => setStuck(!entry?.isIntersecting),
      { rootMargin: '-150px 0px 0px 0px', threshold: 0 },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [sentinelRef]);

  return (
    <div
      data-testid="issue-detail-sticky-header"
      className={cn(
        'sticky top-0 z-30 transition-opacity',
        stuck ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
      aria-hidden={!stuck}
    >
      <div
        className={cn(
          'mx-auto flex h-14 max-w-7xl items-center gap-2 border-b bg-surface/95 px-4 backdrop-blur sm:px-8',
          stuck ? 'border-outline-variant/30 shadow-sm' : 'border-transparent',
        )}
      >
        <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-primary">
          {issue.displayId}
        </span>
        <span className="hidden flex-1 truncate text-sm font-medium text-on-surface md:block">
          {issue.title}
        </span>
        <span className="ml-auto flex items-center gap-2 md:ml-0">
          <InlineStatusSelect issue={issue} onUpdate={onStatusUpdate} />
          <span className="hidden md:inline-flex">
            <InlinePrioritySelect issue={issue} onUpdate={onPatch} />
          </span>
          <span className="hidden md:inline-flex">
            <AssigneePicker
              compact
              value={issue.assigneeId ?? null}
              members={members}
              onChange={(assigneeId) => onPatch(issue.id, { assigneeId })}
            />
          </span>
          <ManualHoldToggle
            compact
            value={issue.manualHold ?? false}
            pending={manualHoldPending}
            onToggle={onManualHoldToggle}
          />
        </span>
      </div>
    </div>
  );
}

