'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Skeleton } from '@/components/ui';
import { usePipelineTiming } from '@/features/issue/hooks/use-pipeline-timing';
import { formatApiError } from '@/lib/api/error';

interface IssuePipelineTimingProps {
  projectId: string;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} m`;
  return `${(ms / 3_600_000).toFixed(2)} h`;
}

interface TimingChartRow {
  status: string;
  avg: number;
  p90: number;
  median: number;
  sampleCount: number;
}

export function IssuePipelineTiming({ projectId }: IssuePipelineTimingProps) {
  const { data, isLoading, error } = usePipelineTiming(projectId);

  return (
    <section className="rounded-sm border border-outline-variant/20 bg-surface">
      <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Pipeline timing
        </h3>
      </div>
      <div className="p-4">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : error ? (
          <p className="text-[10px] uppercase tracking-widest text-error">
            {formatApiError(error)}
          </p>
        ) : !data || data.stats.length === 0 ? (
          <p className="text-[11px] text-outline">Chưa đủ dữ liệu thống kê.</p>
        ) : (
          <Chart stats={data.stats} />
        )}
      </div>
    </section>
  );
}

function Chart({ stats }: { stats: { status: string; sampleCount: number; avgMs: number; medianMs: number; p90Ms: number }[] }) {
  const rows: TimingChartRow[] = stats.map((s) => ({
    status: s.status,
    avg: s.avgMs,
    p90: s.p90Ms,
    median: s.medianMs,
    sampleCount: s.sampleCount,
  }));

  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 6, right: 8, bottom: 6, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
          <XAxis
            dataKey="status"
            tick={{ fontSize: 10, fill: 'currentColor' }}
            interval={0}
            angle={-30}
            textAnchor="end"
            height={50}
          />
          <YAxis tick={{ fontSize: 10, fill: 'currentColor' }} tickFormatter={formatMs} />
          <Tooltip content={<TimingTooltip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
          <Bar dataKey="avg" fill="rgb(var(--color-primary-rgb, 99 102 241))" radius={[2, 2, 0, 0]} />
          <Bar dataKey="p90" fill="rgb(var(--color-tertiary-rgb, 168 85 247))" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface TooltipPayload {
  payload?: TimingChartRow;
}
interface TooltipProps {
  active?: boolean;
  payload?: TooltipPayload[];
}

function TimingTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="rounded-sm border border-outline-variant/30 bg-surface-container-high p-2 text-[11px] text-on-surface">
      <div className="mb-1 font-bold uppercase tracking-widest">{row.status}</div>
      <div>avg: {formatMs(row.avg)}</div>
      <div>median: {formatMs(row.median)}</div>
      <div>p90: {formatMs(row.p90)}</div>
      <div className="text-outline">samples: {row.sampleCount}</div>
    </div>
  );
}

export default IssuePipelineTiming;
