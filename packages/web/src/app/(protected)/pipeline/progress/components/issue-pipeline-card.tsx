'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import { PRIORITY_COLORS } from '@/lib/constants';
import type { Issue } from '@/features/issue/types';
import { getTimeInCurrentStage, getReopenCount, isBottlenecked, formatStageDuration, getStepDurations, isOutlierDuration } from '../utils';
import { PIPELINE_STAGES, STEP_LABELS } from '../constants';
import { RotateCcw } from 'lucide-react';
import type { StepTimingStat } from '@/features/issue/types';

// Step colors for timeline bar segments
const STEP_COLORS = [
  'bg-blue-500', 'bg-indigo-500', 'bg-cyan-500', 'bg-yellow-500',
  'bg-orange-500', 'bg-purple-500', 'bg-teal-500', 'bg-pink-500',
];

interface IssuePipelineCardProps {
  issue: Issue;
  projectSlug?: string;
  stepStats?: StepTimingStat[];
}

export function IssuePipelineCard({ issue, projectSlug, stepStats }: IssuePipelineCardProps) {
  const router = useRouter();
  const timeMs = getTimeInCurrentStage(issue);
  const reopenCount = getReopenCount(issue);
  const bottlenecked = isBottlenecked(issue, PIPELINE_STAGES);
  const stepDurations = useMemo(() => getStepDurations(issue), [issue.changeHistory]);

  const handleClick = () => {
    if (projectSlug) {
      router.push(`/projects/${projectSlug}/issues/${issue.documentId}`);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={!projectSlug}
      className={cn(
        'w-full text-left rounded-sm border border-outline-variant/20 bg-surface-container-low p-2.5 transition-colors hover:bg-surface-container-high group',
        bottlenecked && 'border-l-2 border-l-warning'
      )}
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="font-mono text-[9px] text-primary-fixed">ISS-{issue.id}</span>
            <span className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0', PRIORITY_COLORS[issue.priority]?.split(' ')[0] || 'bg-outline')} />
          </div>
          <p className="text-xs text-on-surface truncate leading-tight">{issue.title}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {issue.agentStatus === 'running' && (
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" title="Agent running" />
          )}
          {issue.agentStatus === 'failed' && (
            <span className="w-1.5 h-1.5 rounded-full bg-error" title="Agent failed" />
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <span
          className={cn(
            'text-[9px] font-mono tabular-nums px-1 py-0.5 rounded-sm',
            bottlenecked ? 'bg-warning/20 text-warning' : 'bg-surface-container-high text-on-surface-variant'
          )}
        >
          {formatStageDuration(timeMs)}
        </span>
        {reopenCount > 0 && (
          <span className="flex items-center gap-0.5 text-[9px] font-mono text-error bg-error/10 px-1 py-0.5 rounded-sm">
            <RotateCcw className="h-2.5 w-2.5" />
            {reopenCount}
          </span>
        )}
      </div>
      {/* Step Timeline Mini-Bar */}
      {stepDurations.length >= 2 && (
        <div className="mt-1.5 group/timeline relative">
          <div className="flex h-1 rounded-full overflow-hidden bg-surface-container-high">
            {(() => {
              const totalDuration = stepDurations.reduce((sum, s) => sum + s.duration, 0);
              return stepDurations.map((s, i) => {
                const pct = (s.duration / totalDuration) * 100;
                const stat = stepStats?.find((st) => st.step === s.step);
                const outlier = stat ? isOutlierDuration(s.duration, stat.p90) : false;
                return (
                  <div
                    key={i}
                    className={cn(
                      'h-full transition-all',
                      outlier ? 'bg-warning' : STEP_COLORS[i % STEP_COLORS.length]
                    )}
                    style={{ width: `${Math.max(pct, 3)}%` }}
                    title={`${STEP_LABELS[s.step] || s.step}: ${formatStageDuration(s.duration)}${outlier ? ' (outlier)' : ''}`}
                  />
                );
              });
            })()}
          </div>
        </div>
      )}
    </button>
  );
}
