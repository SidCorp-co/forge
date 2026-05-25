'use client';

import { useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui';
import { useJobHistory } from '../../hooks/use-job-history';
import { JobDiffPanel } from '../JobDiffPanel';
import { EmptyState } from './EmptyState';

interface Props {
  jobId: string;
  issueId: string | null | undefined;
  step: string | null | undefined;
}

export function HistoryTab({ jobId, issueId, step }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [diffOpen, setDiffOpen] = useState(false);
  const query = useJobHistory(issueId, step);

  // Rows are returned newest-first by the endpoint. Assign older → left,
  // newer → right by sorting selection against `rows[]` index (newer has the
  // lower index).
  const pair = useMemo(() => {
    if (!query.data || selected.length !== 2) return null;
    const idx = (id: string) => query.data!.findIndex((r) => r.jobId === id);
    const sorted = [...selected].sort((a, b) => idx(b) - idx(a));
    return { leftJobId: sorted[0], rightJobId: sorted[1] };
  }, [query.data, selected]);

  if (!issueId || !step) {
    return (
      <EmptyState
        title="No per-issue history"
        body="PM / one-shot jobs are not scoped to an issue, so there is no comparable run history."
      />
    );
  }

  if (query.isLoading) {
    return (
      <div className="space-y-2 px-4 py-3">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (query.error) {
    const msg =
      query.error instanceof Error ? query.error.message : String(query.error);
    return <EmptyState title="Failed to load history" body={msg} />;
  }

  const rows = query.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No runs yet"
        body={`No ${step} jobs have run on this issue.`}
      />
    );
  }

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-widest text-on-surface-variant">
          {rows.length} run{rows.length === 1 ? '' : 's'} of &ldquo;{step}&rdquo;
        </span>
        <button
          type="button"
          disabled={selected.length !== 2}
          onClick={() => setDiffOpen(true)}
          className="rounded border border-outline-variant px-3 py-1 text-xs text-on-surface hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-50"
        >
          Compare selected ({selected.length})
        </button>
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-outline-variant/30 text-left text-[10px] uppercase tracking-widest text-on-surface-variant">
            <th className="w-8 py-1" />
            <th className="py-1">status</th>
            <th className="py-1">model</th>
            <th className="py-1 text-right">tokens</th>
            <th className="py-1 text-right">cost</th>
            <th className="py-1 text-right">duration</th>
            <th className="py-1">started</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isCurrent = r.jobId === jobId;
            const duration =
              r.startedAt && r.finishedAt
                ? `${Math.max(
                    0,
                    Math.round(
                      (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) /
                        1000,
                    ),
                  )}s`
                : '—';
            const tokens =
              r.tokens > 0
                ? r.tokens.toLocaleString()
                : r.estTokens
                  ? `~${r.estTokens.toLocaleString()}`
                  : '—';
            return (
              <tr
                key={r.jobId}
                className={`border-b border-outline-variant/20 ${
                  isCurrent ? 'bg-surface-container-low' : ''
                }`}
              >
                <td className="py-1.5">
                  <input
                    type="checkbox"
                    aria-label={`Select run ${r.jobId}`}
                    checked={selected.includes(r.jobId)}
                    onChange={() => toggle(r.jobId)}
                  />
                </td>
                <td className="py-1.5">{r.status}</td>
                <td className="py-1.5 font-mono text-[11px]">{r.model ?? '—'}</td>
                <td className="py-1.5 text-right tabular-nums">{tokens}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {r.cost > 0 ? `$${r.cost.toFixed(4)}` : '—'}
                </td>
                <td className="py-1.5 text-right tabular-nums">{duration}</td>
                <td className="py-1.5 font-mono text-[10px] text-on-surface-variant">
                  {r.startedAt ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {diffOpen && pair && (
        <JobDiffPanel
          leftJobId={pair.leftJobId}
          rightJobId={pair.rightJobId}
          onClose={() => setDiffOpen(false)}
        />
      )}
    </div>
  );
}
