'use client';

import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ProjectHealthRow } from '@/features/project/api/project-api';
import { useProjectsHealth } from '@/features/project/hooks/use-projects';
import { useThroughput } from '@/features/pipeline/hooks/use-pipeline';

const ACTIVE_STATUSES = [
  'open',
  'confirmed',
  'clarified',
  'approved',
  'in_progress',
  'developed',
  'testing',
  'staging',
  'reopen',
] as const;

const STATUS_COLORS: Record<string, string> = {
  open: '#94a3b8',
  confirmed: '#60a5fa',
  clarified: '#3b82f6',
  approved: '#2563eb',
  in_progress: '#8b5cf6',
  developed: '#a78bfa',
  testing: '#facc15',
  staging: '#f97316',
  reopen: '#ef4444',
};

const RANGE_OPTIONS = [
  { days: 7, label: '7d' },
  { days: 14, label: '14d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
] as const;

export function PipelineHealthDashboard() {
  const { data: health, isLoading: hLoading, error: hErr } = useProjectsHealth();
  const [days, setDays] = useState<number>(30);
  const { data: throughput, isLoading: tLoading } = useThroughput(days);

  const totals = useMemo(() => {
    if (!health) return null;
    return {
      totalActive: health.reduce((s, r) => s + r.totalActive, 0),
      throughput: health.reduce((s, r) => s + r.throughput, 0),
      blockers: health.reduce((s, r) => s + r.blockers.length, 0),
      escalations: health.reduce((s, r) => s + r.pendingEscalations, 0),
    };
  }, [health]);

  const distData = useMemo(() => buildDistributionRows(health ?? []), [health]);
  const trendData = useMemo(() => buildTrendRows(throughput ?? []), [throughput]);
  const projectIds = useMemo(
    () => Array.from(new Set((throughput ?? []).map((p) => p.projectId))),
    [throughput],
  );

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-on-surface">Pipeline Health</h1>
        <p className="mt-1 text-xs text-outline">
          Live metrics across every project you can see (projects you own or are a member of).
        </p>
      </div>

      {hErr && (
        <div className="rounded border border-danger/40 bg-danger-surface/40 p-3 text-sm text-danger">
          Failed to load project health.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total active" value={totals?.totalActive} loading={hLoading} />
        <StatCard label="Closed (7d)" value={totals?.throughput} loading={hLoading} />
        <StatCard label="Blockers" value={totals?.blockers} loading={hLoading} accent="danger" />
        <StatCard
          label="Pending escalations"
          value={totals?.escalations}
          loading={hLoading}
          accent="warning"
        />
      </div>

      <ChartPanel
        title="Status distribution per project"
        subtitle="Issues currently in each pipeline status"
      >
        {hLoading ? (
          <ChartSkeleton />
        ) : distData.length === 0 ? (
          <EmptyChart message="No active issues yet." />
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={distData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" />
              <XAxis dataKey="project" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: 'none' }} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              {ACTIVE_STATUSES.map((s) => (
                <Bar key={s} dataKey={s} stackId="status" fill={STATUS_COLORS[s] ?? '#64748b'} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartPanel>

      <ChartPanel
        title="Throughput trend"
        subtitle="Daily closures (status → closed or released)"
        right={
          <div className="flex items-center gap-1">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                onClick={() => setDays(opt.days)}
                className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded-sm ${
                  days === opt.days
                    ? 'bg-primary text-on-primary'
                    : 'text-on-surface-variant hover:bg-surface-container-low'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        }
      >
        {tLoading ? (
          <ChartSkeleton />
        ) : trendData.length === 0 ? (
          <EmptyChart message="No closures in this window." />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: 'none' }} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              {projectIds.map((pid, i) => (
                <Line
                  key={pid}
                  type="monotone"
                  dataKey={pid}
                  name={shortenId(pid)}
                  stroke={pickColor(i)}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartPanel>

      <ChartPanel title="Active blockers" subtitle="Issues stuck in on_hold or needs_info">
        {hLoading ? (
          <ChartSkeleton />
        ) : (health ?? []).every((r) => r.blockers.length === 0) ? (
          <EmptyChart message="No blockers — everything moving." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-outline-variant/20 text-[10px] uppercase tracking-[0.15em] text-outline">
                  <th className="px-3 py-2 text-left font-medium">Project</th>
                  <th className="px-3 py-2 text-left font-medium">Issue</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {(health ?? []).flatMap((r) =>
                  r.blockers.map((b) => (
                    <tr
                      key={b.documentId}
                      className="border-b border-outline-variant/10 last:border-b-0"
                    >
                      <td className="px-3 py-2 text-on-surface-variant">{r.projectName}</td>
                      <td className="px-3 py-2 font-mono text-xs text-on-surface">{b.issueId}</td>
                      <td className="px-3 py-2 text-on-surface-variant">{b.status}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </ChartPanel>
    </div>
  );
}

function StatCard({
  label,
  value,
  loading,
  accent,
}: {
  label: string;
  value: number | undefined;
  loading?: boolean;
  accent?: 'danger' | 'warning';
}) {
  const accentClass =
    accent === 'danger'
      ? 'text-danger'
      : accent === 'warning'
        ? 'text-warning'
        : 'text-on-surface';
  return (
    <div className="rounded-sm border border-outline-variant/30 bg-surface-container-low p-4">
      <p className="text-[10px] uppercase tracking-[0.15em] text-outline">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${accentClass}`}>
        {loading ? '—' : (value ?? 0)}
      </p>
    </div>
  );
}

function ChartPanel({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-sm border border-outline-variant/30 bg-surface-container-low">
      <header className="flex items-center justify-between border-b border-outline-variant/20 px-4 py-3">
        <div>
          <h2 className="text-[10px] uppercase tracking-[0.15em] font-bold text-on-surface-variant">
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-[10px] text-outline">{subtitle}</p>}
        </div>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function ChartSkeleton() {
  return <div className="h-64 animate-pulse rounded bg-surface-container-high/30" />;
}

function EmptyChart({ message }: { message: string }) {
  return <p className="py-12 text-center text-xs text-outline">{message}</p>;
}

function buildDistributionRows(health: ProjectHealthRow[]) {
  return health.map((p) => {
    const row: Record<string, string | number> = { project: p.projectSlug };
    for (const s of ACTIVE_STATUSES) {
      row[s] = p.statusDistribution[s] ?? 0;
    }
    return row;
  });
}

function buildTrendRows(points: Array<{ projectId: string; date: string; count: number }>) {
  const byDate = new Map<string, Record<string, string | number>>();
  for (const p of points) {
    const row = byDate.get(p.date) ?? { date: p.date };
    row[p.projectId] = p.count;
    byDate.set(p.date, row);
  }
  return Array.from(byDate.values()).sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  );
}

function shortenId(id: string): string {
  return id.slice(0, 8);
}

const PALETTE = [
  '#3b82f6',
  '#8b5cf6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
];

function pickColor(i: number): string {
  return PALETTE[i % PALETTE.length] ?? '#64748b';
}

export default PipelineHealthDashboard;
