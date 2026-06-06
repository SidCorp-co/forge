'use client';

import type { Issue, IssuePatchInput } from '@forge/contracts';
import { Loader2, Play } from 'lucide-react';
import { AssigneePicker } from '@/components/issue/assignee-picker';
import { InlineComplexitySelect } from '@/components/issue/inline-complexity-select';
import { InlinePrioritySelect } from '@/components/issue/inline-priority-select';
import { InlineStatusSelect } from '@/components/issue/inline-status-select';
import { useProjectMembers } from '@/features/project/hooks/use-project-members';
import type { IssueStatus } from '@/features/issue/types';

interface IssueMetadataProps {
  issue: Issue;
  desktopConnected: boolean;
  isBuildingPrompt: boolean;
  onUpdate: (
    id: string,
    data: IssuePatchInput | { status: IssueStatus },
  ) => void;
  onStartSession: () => void;
}

function statusActionLabel(status: string): string {
  switch (status) {
    case 'open':
      return 'Triage';
    case 'confirmed':
    case 'clarified':
      return 'Plan';
    case 'approved':
    case 'in_progress':
      return 'Code';
    case 'testing':
      return 'QA Test';
    case 'reopen':
      return 'Fix';
    default:
      return 'Start Session';
  }
}

export function IssueMetadata({
  issue,
  desktopConnected,
  isBuildingPrompt,
  onUpdate,
  onStartSession,
}: IssueMetadataProps) {
  const { data: members = [] } = useProjectMembers(issue.projectId);
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-4 px-4 py-4 sm:px-8 border-b border-outline-variant/30 bg-background">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Status</span>
        <InlineStatusSelect issue={issue} onUpdate={(id, data) => onUpdate(id, data)} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Complexity</span>
        <InlineComplexitySelect issue={issue} onUpdate={(id, data) => onUpdate(id, data)} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Priority</span>
        <InlinePrioritySelect issue={issue} onUpdate={(id, data) => onUpdate(id, data)} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Assignee</span>
        <AssigneePicker
          value={issue.assigneeId ?? null}
          members={members}
          onChange={(assigneeId) => onUpdate(issue.id, { assigneeId })}
        />
      </div>
      {issue.category && (
        <span className="rounded-sm border border-outline-variant/30 bg-surface-container-low px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-tertiary">
          {issue.category}
        </span>
      )}
      {desktopConnected && issue.status !== 'released' && issue.status !== 'closed' && (
        <button
          onClick={onStartSession}
          disabled={isBuildingPrompt}
          className="flex items-center gap-2 ml-auto rounded-sm bg-primary px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-on-primary hover:bg-on-surface-variant shadow-sm transition-all disabled:opacity-50"
        >
          {isBuildingPrompt ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          {statusActionLabel(issue.status)}
        </button>
      )}
    </div>
  );
}
