'use client';

import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { CostTrend, CostTrendAnnotation, CostTrendDaily } from '../types';
import { formatUsd } from './format';
import { Panel, ErrorPill, LoadingLine } from './panel';

interface Props {
  query: UseQueryResult<CostTrend>;
}

export function CostTrendChart({ query }: Props) {
  const { data, isLoading, error } = query;

  const annotationsByDate = useMemo(() => {
    const map = new Map<string, CostTrendAnnotation[]>();
    if (!data) return map;
    for (const a of data.annotations) {
      const day = a.ts.slice(0, 10);
      const bucket = map.get(day) ?? [];
      bucket.push(a);
      map.set(day, bucket);
    }
    return map;
  }, [data]);

  const annotationDays = useMemo(
    () => Array.from(annotationsByDate.keys()),
    [annotationsByDate],
  );

  return (
    <Panel title="Cost trend · 90d" subtitle="Daily spend, config-change markers">
      {isLoading ? (
        <LoadingLine />
      ) : error ? (
        <ErrorPill message="Failed to load cost trend." />
      ) : !data || data.daily.length === 0 ? (
        <p className="py-8 text-center text-xs text-outline">No data yet in this window.</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data.daily} margin={{ left: 8, right: 12, top: 8, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10 }}
              tickFormatter={(d: string) => d.slice(5)}
              minTickGap={24}
            />
            <YAxis
              tick={{ fontSize: 10 }}
              tickFormatter={(v: number) => formatUsd(v)}
              width={64}
            />
            <Tooltip
              cursor={{ stroke: 'rgba(148,163,184,0.4)', strokeDasharray: '2 2' }}
              content={
                ((p: unknown) =>
                  renderTrendTooltip(
                    p as Parameters<typeof renderTrendTooltip>[0],
                    annotationsByDate,
                  )) as never
              }
            />
            {annotationDays.map((day) => (
              <ReferenceLine
                key={day}
                x={day}
                stroke="var(--color-tertiary, #f97316)"
                strokeDasharray="4 4"
                ifOverflow="hidden"
              />
            ))}
            <Line
              type="monotone"
              dataKey="cost"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Panel>
  );
}

interface TooltipPayload {
  payload?: CostTrendDaily;
}

function renderTrendTooltip(
  props: { active?: boolean; payload?: TooltipPayload[]; label?: string | number },
  annotationsByDate: Map<string, CostTrendAnnotation[]>,
): ReactElement | null {
  const { active, payload, label } = props;
  if (!active || !payload || payload.length === 0) return null;

  const row = payload[0]?.payload;
  if (!row) return null;
  const annotations = annotationsByDate.get(String(label ?? row.date)) ?? [];

  return (
    <div className="rounded-sm bg-surface-container-high/95 border border-outline-variant/30 px-3 py-2 text-xs shadow-md">
      <div className="font-mono text-on-surface-variant">{row.date}</div>
      <div className="mt-0.5 text-on-surface">
        {formatUsd(row.cost)} · {row.runs} runs
      </div>
      {annotations.map((a, i) => (
        <div
          key={i}
          className="mt-1 border-t border-outline-variant/20 pt-1 text-[11px] text-tertiary"
        >
          {a.message}
        </div>
      ))}
    </div>
  );
}
