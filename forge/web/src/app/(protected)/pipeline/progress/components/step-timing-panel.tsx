'use client';

import { useState } from 'react';
import { usePipelineTiming } from '@/features/issue/hooks/use-pipeline-timing';
import { STEP_LABELS, TIME_WINDOWS } from '../constants';
import { formatStageDuration } from '../utils';
import { Timer, AlertTriangle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export function StepTimingPanel() {
  const [windowIdx, setWindowIdx] = useState(1); // default 7d
  const window = TIME_WINDOWS[windowIdx];
  const now = new Date();
  const from = new Date(now.getTime() - window.days * 86400000).toISOString().split('T')[0];
  const to = now.toISOString().split('T')[0];

  const { data, isLoading } = usePipelineTiming({ from, to });

  const steps = (data?.steps ?? [])
    .filter((s) => s.count >= 1)
    .sort((a, b) => b.avg - a.avg);

  const maxAvg = Math.max(...steps.map((s) => s.avg), 1);

  return (
    <div className="bg-surface-container-low p-4 rounded-sm border border-outline-variant/10">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em] flex items-center gap-1.5">
          <Timer className="h-3 w-3" />
          Step Timing
        </h3>
        <div className="flex gap-1">
          {TIME_WINDOWS.map((w, i) => (
            <button
              key={w.label}
              onClick={() => setWindowIdx(i)}
              className={cn(
                'text-[9px] font-mono px-1.5 py-0.5 rounded-sm transition-colors',
                i === windowIdx
                  ? 'bg-primary/20 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-container-high'
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-on-surface-variant" />
        </div>
      ) : steps.length === 0 ? (
        <p className="text-[10px] text-outline-variant text-center py-2">No transitions in this window</p>
      ) : (
        <div className="space-y-2">
          {steps.map((s) => {
            const label = STEP_LABELS[s.step] || s.step;
            const avgPct = (s.avg / maxAvg) * 100;
            const p90Pct = (s.p90 / maxAvg) * 100;
            const hasOutliers = s.outliers.length > 0;

            return (
              <div key={s.step}>
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-on-surface-variant">{label}</span>
                    {hasOutliers && (
                      <span className="flex items-center gap-0.5 text-[8px] text-warning">
                        <AlertTriangle className="h-2 w-2" />
                        {s.outliers.length}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-mono text-on-surface-variant tabular-nums">
                      avg {formatStageDuration(s.avg)}
                    </span>
                    <span className="text-[9px] font-mono text-outline tabular-nums">
                      p90 {formatStageDuration(s.p90)}
                    </span>
                    <span className="text-[8px] font-mono text-outline tabular-nums">
                      n={s.count}
                    </span>
                  </div>
                </div>
                <div className="h-1.5 bg-surface-container-high rounded-full overflow-hidden relative">
                  <div
                    className="absolute h-full bg-outline/30 rounded-full"
                    style={{ width: `${Math.max(p90Pct, 2)}%` }}
                  />
                  <div
                    className={cn(
                      'absolute h-full rounded-full',
                      hasOutliers ? 'bg-warning' : 'bg-primary'
                    )}
                    style={{ width: `${Math.max(avgPct, 2)}%` }}
                  />
                </div>
              </div>
            );
          })}
          <div className="flex items-center gap-3 pt-1 border-t border-outline-variant/10">
            <span className="text-[8px] text-outline uppercase tracking-widest">
              {data?.totalIssuesAnalyzed ?? 0} issues analyzed
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
