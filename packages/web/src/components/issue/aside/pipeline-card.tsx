'use client';

import { IssuePipelineActions } from '@/components/issue/issue-detail-modal/issue-pipeline-actions';
import type { Issue } from '@forge/contracts';

interface PipelineCardProps {
  issue: Issue;
}

export function PipelineCard({ issue }: PipelineCardProps) {
  return (
    <section className="sticky top-6 rounded-sm border border-outline-variant/20 bg-surface">
      <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Pipeline
        </h3>
      </div>
      <div className="space-y-3 p-4 text-sm">
        <IssuePipelineActions issueId={issue.id} status={issue.status} />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
            Recovery
          </span>
          <span className="font-mono text-xs text-on-surface">{issue.reopenCount ?? 0}</span>
        </div>
      </div>
    </section>
  );
}
