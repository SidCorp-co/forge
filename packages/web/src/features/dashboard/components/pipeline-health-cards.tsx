'use client';

import { ALL_STATUSES, STATUS_COLORS } from '@/lib/constants';
import type { IssueStatus } from '@/features/issue/types';

interface PipelineHealthCardsProps {
  statusDistribution: Record<string, number>;
  totalIssues: number;
}

export function PipelineHealthCards({ statusDistribution, totalIssues }: PipelineHealthCardsProps) {
  // Keep ALL_STATUSES ordering (open → released → side states); drop zero-count
  // states so the grid doesn't render a wall of empty cards.
  const entries = ALL_STATUSES.map((s) => ({
    status: s.value,
    label: s.label,
    count: statusDistribution[s.value] ?? 0,
  })).filter((e) => e.count > 0);

  if (totalIssues === 0 || entries.length === 0) {
    return <p className="text-xs text-outline">No issues yet.</p>;
  }

  return (
    <div className="space-y-3">
      {/* Thin proportion bar — quick visual summary above the per-state cards. */}
      <div className="flex h-2 w-full overflow-hidden rounded-sm bg-surface-container-high">
        {entries.map((e) => (
          <div
            key={e.status}
            className={STATUS_COLORS[e.status as IssueStatus] ?? 'bg-outline-variant'}
            style={{ width: `${(e.count / totalIssues) * 100}%` }}
            title={`${e.label}: ${e.count}`}
          />
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {entries.map((e) => (
          <div
            key={e.status}
            className="flex flex-col gap-1.5 rounded-sm border border-outline-variant/20 bg-surface-container-low px-3 py-2"
          >
            <span
              className={`inline-flex w-fit rounded-sm px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${STATUS_COLORS[e.status as IssueStatus] ?? 'bg-outline-variant text-outline'}`}
            >
              {e.label}
            </span>
            <span className="text-xl font-bold tabular-nums text-on-surface">{e.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default PipelineHealthCards;
