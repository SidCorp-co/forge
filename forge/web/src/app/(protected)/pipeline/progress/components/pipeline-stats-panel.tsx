'use client';

import type { Issue } from '@/features/issue/types';
import { usePipelineTiming } from '@/features/issue/hooks/use-pipeline-timing';
import { PIPELINE_STAGES, STEP_LABELS } from '../constants';
import { computeStageMetrics, formatStageDuration, getReopenCount } from '../utils';
import type { StageMetric } from '../utils';
import { AlertTriangle, TrendingUp, Clock, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

function StageDurationBars({ metrics }: { metrics: StageMetric[] }) {
  const populated = metrics.filter((m) => m.count > 0);
  const maxAvg = Math.max(...populated.map((x) => x.avgTimeMs), 1);

  if (populated.length === 0) {
    return <p className="text-[10px] text-outline-variant text-center py-2">No active issues</p>;
  }

  return (
    <div className="space-y-2">
      {populated.map((m) => {
        const pct = (m.avgTimeMs / maxAvg) * 100;
        return (
          <div key={m.key}>
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[10px] text-on-surface-variant">{m.label}</span>
              <span className="text-[10px] font-mono text-on-surface tabular-nums">{formatStageDuration(m.avgTimeMs)}</span>
            </div>
            <div className="h-1 bg-surface-container-high rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${Math.max(pct, 2)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ServerStepBars() {
  const now = new Date();
  const from = new Date(now.getTime() - 7 * 86400000).toISOString().split('T')[0];
  const to = now.toISOString().split('T')[0];
  const { data } = usePipelineTiming({ from, to });

  const steps = (data?.steps ?? []).filter((s) => s.count >= 1).sort((a, b) => b.avg - a.avg);
  const maxAvg = Math.max(...steps.map((s) => s.avg), 1);

  if (steps.length === 0) return null;

  return (
    <div className="space-y-2 mt-3 pt-3 border-t border-outline-variant/10">
      <div className="text-[8px] text-outline uppercase tracking-widest mb-1">7-day avg vs p90</div>
      {steps.slice(0, 6).map((s) => {
        const label = STEP_LABELS[s.step] || s.step;
        const avgPct = (s.avg / maxAvg) * 100;
        const hasOutliers = s.outliers.length > 0;
        return (
          <div key={s.step}>
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[10px] text-on-surface-variant">{label}</span>
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] font-mono text-on-surface tabular-nums">{formatStageDuration(s.avg)}</span>
                {hasOutliers && (
                  <span className={cn('text-[8px] font-mono text-warning tabular-nums')}>
                    {s.outliers.length} outlier{s.outliers.length > 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </div>
            <div className="h-1 bg-surface-container-high rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', hasOutliers ? 'bg-warning' : 'bg-primary')}
                style={{ width: `${Math.max(avgPct, 2)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface PipelineStatsPanelProps {
  issues: Issue[];
}

export function PipelineStatsPanel({ issues }: PipelineStatsPanelProps) {
  const metrics = computeStageMetrics(issues, PIPELINE_STAGES);
  const activeMetrics = metrics.filter((m) => m.key !== 'done');

  const totalBottlenecked = activeMetrics.reduce((sum, m) => sum + m.bottleneckedCount, 0);

  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const completedToday = issues.filter(
    (i) => (i.status === 'released' || i.status === 'closed') && new Date(i.updatedAt).getTime() > oneDayAgo
  ).length;
  const completedThisWeek = issues.filter(
    (i) => (i.status === 'released' || i.status === 'closed') && new Date(i.updatedAt).getTime() > oneWeekAgo
  ).length;

  const reopenedIssues = issues
    .map((i) => ({ issue: i, count: getReopenCount(i) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const bottleneckStages = activeMetrics
    .filter((m) => m.bottleneckedCount > 0)
    .sort((a, b) => b.bottleneckedCount - a.bottleneckedCount);

  return (
    <div className="space-y-4">
      {/* Throughput */}
      <div className="bg-surface-container-low p-4 rounded-sm border border-outline-variant/10">
        <h3 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5">
          <TrendingUp className="h-3 w-3" />
          Throughput
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-[10px] text-on-surface-variant uppercase mb-0.5">Today</div>
            <div className="text-lg font-mono font-medium text-success tabular-nums">{completedToday}</div>
          </div>
          <div>
            <div className="text-[10px] text-on-surface-variant uppercase mb-0.5">This Week</div>
            <div className="text-lg font-mono font-medium text-on-surface tabular-nums">{completedThisWeek}</div>
          </div>
        </div>
      </div>

      {/* Bottleneck Alerts */}
      {totalBottlenecked > 0 && (
        <div className="bg-surface-container-low p-4 rounded-sm border border-outline-variant/10">
          <h3 className="text-[10px] font-bold text-warning uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3" />
            Bottlenecks ({totalBottlenecked})
          </h3>
          <div className="space-y-2">
            {bottleneckStages.map((m) => (
              <div key={m.key} className="flex items-center justify-between">
                <span className="text-xs text-on-surface-variant">{m.label}</span>
                <span className="text-xs font-mono text-warning tabular-nums">{m.bottleneckedCount} stuck</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stage Durations — live client-side + server-computed 7d stats */}
      <div className="bg-surface-container-low p-4 rounded-sm border border-outline-variant/10">
        <h3 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5">
          <Clock className="h-3 w-3" />
          Avg Time in Stage
        </h3>
        <StageDurationBars metrics={activeMetrics} />
        <ServerStepBars />
      </div>

      {/* Top Reopened */}
      {reopenedIssues.length > 0 && (
        <div className="bg-surface-container-low p-4 rounded-sm border border-outline-variant/10">
          <h3 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5">
            <RotateCcw className="h-3 w-3" />
            Fix Loops
          </h3>
          <div className="space-y-1.5">
            {reopenedIssues.map(({ issue, count }) => (
              <div key={issue.documentId} className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-on-surface-variant truncate flex-1">
                  <span className="font-mono text-primary-fixed">ISS-{issue.id}</span>{' '}
                  {issue.title}
                </span>
                <span className="text-[10px] font-mono text-error shrink-0">{count}x</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
