'use client';

import { IssueBlockedBanner } from '@/components/issue/issue-blocked-banner';
import { IssueParentBreadcrumb } from '@/components/issue/issue-parent-breadcrumb';
import { IssueRelations } from '@/components/issue/issue-relations';
import type { Issue } from '@forge/contracts';

interface LinkedCardProps {
  issue: Issue;
  projectSlug: string;
}

export function LinkedCard({ issue, projectSlug }: LinkedCardProps) {
  return (
    <section className="sticky top-6 space-y-3 rounded-sm border border-outline-variant/20 bg-surface">
      <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Linked
        </h3>
      </div>
      <div className="space-y-3 p-4 text-sm">
        <IssueBlockedBanner issueId={issue.id} />
        <IssueParentBreadcrumb
          issueId={issue.id}
          projectSlug={projectSlug}
          currentDisplayId={issue.displayId}
        />
        <IssueRelations
          issueId={issue.id}
          projectId={issue.projectId}
          projectSlug={projectSlug}
        />
      </div>
    </section>
  );
}
