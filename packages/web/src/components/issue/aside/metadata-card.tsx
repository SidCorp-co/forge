'use client';

import { AssigneePicker } from '@/components/issue/assignee-picker';
import { InlineStatusSelect } from '@/components/issue/inline-status-select';
import { InlinePrioritySelect } from '@/components/issue/inline-priority-select';
import { InlineComplexitySelect } from '@/components/issue/inline-complexity-select';
import type { Issue, IssuePatchInput } from '@forge/contracts';
import type { IssueStatus } from '@/features/issue/types';
import type { ProjectMemberRow } from '@/features/project/hooks/use-project-members';

interface MetadataCardProps {
  issue: Issue;
  members: ProjectMemberRow[];
  onStatusUpdate: (issueId: string, data: { status: IssueStatus }) => void;
  onPatch: (issueId: string, patch: IssuePatchInput) => void;
}

export function MetadataCard({ issue, members, onStatusUpdate, onPatch }: MetadataCardProps) {
  return (
    <section className="sticky top-6 rounded-sm border border-outline-variant/20 bg-surface">
      <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Metadata
        </h3>
      </div>
      <div className="space-y-3 p-4 text-sm">
        <Row label="Status">
          <InlineStatusSelect issue={issue} onUpdate={onStatusUpdate} />
        </Row>
        <Row label="Priority">
          <InlinePrioritySelect issue={issue} onUpdate={onPatch} />
        </Row>
        <Row label="Complexity">
          <InlineComplexitySelect issue={issue} onUpdate={onPatch} />
        </Row>
        <Row label="Assignee">
          <AssigneePicker
            value={issue.assigneeId ?? null}
            members={members}
            onChange={(assigneeId) => onPatch(issue.id, { assigneeId })}
          />
        </Row>
        <Row label="Category">
          {issue.category ? (
            <span className="inline-flex items-center rounded-sm border border-outline-variant/30 bg-surface-container-high px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest">
              {issue.category}
            </span>
          ) : (
            <span className="text-outline">—</span>
          )}
        </Row>
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
