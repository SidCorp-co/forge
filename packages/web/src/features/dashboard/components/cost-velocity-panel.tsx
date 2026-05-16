'use client';

import { Gauge } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { formatApiError } from '@/lib/api/error';
import { useStepDurations } from '../hooks/use-step-durations';
import type { StepDurationRow, StepName } from '../types';

interface CostVelocityPanelProps {
  projectId: string;
}

interface Aggregate {
  step: StepName;
  p95Seconds: number;
  totalCostUsd: number;
  count: number;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

function aggregate(rows: StepDurationRow[]): Aggregate[] {
  const byStep = new Map<StepName, number[]>();
  const costByStep = new Map<StepName, number>();
  for (const r of rows) {
    if (!byStep.has(r.step)) byStep.set(r.step, []);
    byStep.get(r.step)!.push(r.durationSeconds);
    costByStep.set(r.step, (costByStep.get(r.step) ?? 0) + r.costUsd);
  }
  const out: Aggregate[] = [];
  for (const [step, durations] of byStep) {
    out.push({
      step,
      p95Seconds: p95(durations),
      totalCostUsd: costByStep.get(step) ?? 0,
      count: durations.length,
    });
  }
  return out.sort((a, b) => b.p95Seconds - a.p95Seconds);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds - mins * 60);
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

export function CostVelocityPanel({ projectId }: CostVelocityPanelProps) {
  const { data, isLoading, error } = useStepDurations(projectId, 7);

  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
        <Gauge className="h-3.5 w-3.5" />
        Cost &amp; velocity (7d)
      </h2>
      {isLoading ? (
        <Skeleton className="h-24" />
      ) : error ? (
        <div className="rounded-sm border border-error/30 bg-error-container/10 p-3 text-xs text-error">
          {formatApiError(error)}
        </div>
      ) : (
        <CostVelocityBody rows={data ?? []} />
      )}
    </section>
  );
}

function CostVelocityBody({ rows }: { rows: StepDurationRow[] }) {
  const aggregates = aggregate(rows);

  if (aggregates.length === 0) {
    return <p className="text-xs text-outline">No pipeline activity in the last 7 days.</p>;
  }

  return (
    <ul className="divide-y divide-outline-variant/20 rounded-sm border border-outline-variant/20 bg-surface-container-low">
      {aggregates.map((a) => (
        <li
          key={a.step}
          className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-3 py-2 text-xs"
        >
          <span className="font-mono lowercase tracking-widest text-on-surface-variant">{a.step}</span>
          <span className="font-mono tabular-nums text-on-surface">
            {formatDuration(a.p95Seconds)}
          </span>
          <span className="font-mono tabular-nums text-on-surface-variant">
            {formatCost(a.totalCostUsd)}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-widest text-outline">
            n={a.count}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default CostVelocityPanel;
