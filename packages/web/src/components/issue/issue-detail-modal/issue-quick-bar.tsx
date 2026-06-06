'use client';

import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui';
import { InlineStatusSelect } from '@/components/issue/inline-status-select';
import { InlinePrioritySelect } from '@/components/issue/inline-priority-select';
import { AssigneePicker } from '@/components/issue/assignee-picker';
import { IssuePipelineActions } from '@/components/issue/issue-detail-modal/issue-pipeline-actions';
import { PIPELINE_STAGES } from '@/app/(protected)/pipeline/progress/constants';
import type { Issue, IssuePatchInput } from '@forge/contracts';
import type { IssueStatus } from '@/features/issue/types';
import type { ProjectMemberRow } from '@/features/project/hooks/use-project-members';

interface IssueQuickBarProps {
  issue: Issue;
  members: ProjectMemberRow[];
  projectSlug: string;
  onStatusUpdate: (issueId: string, data: { status: IssueStatus }) => void;
  onPatch: (issueId: string, patch: IssuePatchInput) => void;
  onClose: () => void;
}

/**
 * ISS-390 — pinned, non-scrolling quick bar at the top of the board quick-open
 * modal. Surfaces at-a-glance key info plus the most-used inline actions so the
 * operator can review and act without scrolling the full IssueDetailBody below.
 *
 * Purely additive and composed entirely of existing primitives — the shared
 * IssueDetailBody (and its sidebar cards) stay untouched, so the full detail
 * page cannot regress. InlineStatusSelect already renders the AwaitingHumanBadge,
 * so the bar relies on that rather than duplicating it.
 */
export function IssueQuickBar({
  issue,
  members,
  projectSlug,
  onStatusUpdate,
  onPatch,
  onClose,
}: IssueQuickBarProps) {
  const currentStatus = issue.status as IssueStatus;
  // Same stage-resolution logic as issue-detail-header.tsx — skip the synthetic
  // "blocked" lane and match the current status to its pipeline stage.
  const currentStage = PIPELINE_STAGES.filter((s) => s.key !== 'blocked').find((s) =>
    (s.statuses as readonly string[]).includes(currentStatus),
  );

  return (
    <div className="mb-3 border-b border-outline-variant/20 pb-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-mono text-sm tracking-widest text-primary shrink-0">
          {issue.displayId}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-on-surface">
          {issue.title}
        </span>
        {currentStage && (
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
            {currentStage.label}
          </span>
        )}
        {issue.category && (
          <span className="inline-flex shrink-0 items-center rounded-sm border border-outline-variant/30 bg-surface-container-high px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest">
            {issue.category}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <InlineStatusSelect issue={issue} onUpdate={onStatusUpdate} />
        <InlinePrioritySelect issue={issue} onUpdate={onPatch} />
        <AssigneePicker
          value={issue.assigneeId ?? null}
          members={members}
          onChange={(assigneeId) => onPatch(issue.id, { assigneeId })}
          compact
        />
        <IssuePipelineActions issueId={issue.id} status={issue.status} />
        <Link
          href={`/projects/${projectSlug}/issues/${issue.displayId}`}
          onClick={onClose}
          className="ml-auto shrink-0"
        >
          <Button size="xs" variant="ghost">
            <ExternalLink className="h-3 w-3" /> Open full
          </Button>
        </Link>
      </div>
    </div>
  );
}
