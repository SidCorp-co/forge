'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils/cn';
import type { Issue, StepTimingStat } from '@/features/issue/types';
import type { PipelineStage } from '../constants';
import { PIPELINE_STAGES } from '../constants';
import { getTimeInCurrentStage, isBottlenecked } from '../utils';
import { IssuePipelineCard } from './issue-pipeline-card';

interface StageColumnProps {
  stage: PipelineStage;
  issues: Issue[];
  stepStats?: StepTimingStat[];
}

export function StageColumn({ stage, issues, stepStats }: StageColumnProps) {
  const Icon = stage.icon;

  const sorted = useMemo(() =>
    [...issues].sort((a, b) => {
      const aBottle = isBottlenecked(a, PIPELINE_STAGES) ? 1 : 0;
      const bBottle = isBottlenecked(b, PIPELINE_STAGES) ? 1 : 0;
      if (bBottle !== aBottle) return bBottle - aBottle;
      return getTimeInCurrentStage(b) - getTimeInCurrentStage(a);
    }),
    [issues]
  );

  return (
    <div className={cn('min-w-[200px] flex-1 rounded-sm border-t-2 p-3 flex flex-col', stage.color, stage.bg)}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-on-surface-variant" />
          <h3 className="text-xs font-semibold text-primary uppercase tracking-wide">{stage.label}</h3>
        </div>
        <span className="rounded-sm bg-surface-container-high px-1.5 py-0.5 text-[10px] font-mono font-medium text-on-surface-variant tabular-nums">
          {issues.length}
        </span>
      </div>
      <div className="space-y-1.5 flex-1 overflow-y-auto max-h-[calc(100vh-320px)]">
        {sorted.map((issue) => (
          <IssuePipelineCard
            key={issue.documentId}
            issue={issue}
            projectSlug={issue.project?.slug}
            stepStats={stepStats}
          />
        ))}
        {issues.length === 0 && (
          <p className="py-6 text-center text-[10px] text-outline-variant">No issues</p>
        )}
      </div>
    </div>
  );
}
