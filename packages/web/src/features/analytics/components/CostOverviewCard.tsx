'use client';

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { UseQueryResult } from '@tanstack/react-query';
import type { CostSummary, CostSummaryByState } from '../types';
import type { ReactElement } from 'react';
import { formatUsd } from './format';
import { Panel, ErrorPill, LoadingLine } from './panel';

interface Props {
  query: UseQueryResult<CostSummary>;
}

export function CostOverviewCard({ query }: Props) {
  const { data, isLoading, error } = query;

  const sortedByState = useMemo<CostSummaryByState[]>(() => {
    if (!data) return [];
    return [...data.byState].sort((a, b) => b.total - a.total);
  }, [data]);

  const totalRuns = useMemo(
    () => sortedByState.reduce((acc, r) => acc + r.runs, 0),
    [sortedByState],
  );

  return (
    <Panel
      title="Cost overview · 30d"
      subtitle="Spend by pipeline state"
      right={
        data ? (
          <div className="text-right">
            <div className="text-lg font-bold text-on-surface">{formatUsd(data.total)}</div>
            <div className="text-[10px] text-outline">{totalRuns} runs</div>
          </div>
        ) : null
      }
    >
      {isLoading ? (
        <LoadingLine />
      ) : error ? (
        <ErrorPill message="Failed to load cost summary." />
      ) : sortedByState.length === 0 ? (
        <p className="py-8 text-center text-xs text-outline">No cost yet in this window.</p>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(120, sortedByState.length * 28 + 40)}>
          <BarChart data={sortedByState} layout="vertical" margin={{ left: 12, right: 12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 10 }}
              tickFormatter={(v: number) => formatUsd(v)}
            />
            <YAxis
              type="category"
              dataKey="state"
              tick={{ fontSize: 10 }}
              width={80}
            />
            <Tooltip
              cursor={{ fill: 'rgba(148,163,184,0.08)' }}
              content={renderStateTooltip as never}
            />
            <Bar dataKey="total" fill="#3b82f6" radius={[0, 2, 2, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}

      {data && data.byIssue.length > 0 && (
        <div className="mt-4 border-t border-outline-variant/20 pt-3">
          <h3 className="mb-2 text-[10px] uppercase tracking-[0.15em] font-bold text-on-surface-variant">
            Top issues
          </h3>
          <ul className="space-y-1">
            {data.byIssue.slice(0, 5).map((row) => (
              <li
                key={row.issueId}
                className="flex items-center justify-between text-xs"
              >
                <span className="font-mono text-on-surface-variant truncate" title={row.issueId}>
                  {row.issueId.slice(0, 8)}…
                </span>
                <span className="text-on-surface">{formatUsd(row.total)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function renderStateTooltip(props: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
}): ReactElement | null {
  if (!props.active || !props.payload || props.payload.length === 0) return null;
  const row = props.payload[0]?.payload as CostSummaryByState | undefined;
  if (!row) return null;
  return (
    <div className="rounded-sm bg-surface-container-high/95 border border-outline-variant/30 px-3 py-2 text-xs shadow-md">
      <div className="font-semibold text-on-surface">{row.state}</div>
      <div className="mt-0.5 text-on-surface-variant">
        {formatUsd(row.total)} · {row.runs} runs
      </div>
      <div className="text-[11px] text-outline">{formatUsd(row.avgPerRun)} per run</div>
    </div>
  );
}
