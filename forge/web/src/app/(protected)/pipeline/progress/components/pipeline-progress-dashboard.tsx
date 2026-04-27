'use client';

import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ProjectHealthRow } from '@/features/project/api/project-api';
import { useCycleTime } from '@/features/pipeline/hooks/use-pipeline';
import { useProjectsHealth } from '@/features/project/hooks/use-projects';

const STAGES = [
  'open',
  'confirmed',
  'clarified',
  'approved',
  'in_progress',
  'developed',
  'deploying',
  'testing',
  'tested',
  'pass',
  'staging',
  'released',
  'closed',
] as const;

const STAGE_COLORS: Record<string, string> = {
  open: '#94a3b8',
  confirmed: '#60a5fa',
  clarified: '#3b82f6',
  approved: '#2563eb',
  in_progress: '#8b5cf6',
  developed: '#a78bfa',
  deploying: '#facc15',
  testing: '#f59e0b',
  tested: '#10b981',
  pass: '#22c55e',
  staging: '#06b6d4',
  released: '#0ea5e9',
  closed: '#64748b',
};

export function PipelineProgressDashboard() {
  const { data: health, isLoading: hLoading } = useProjectsHealth();
  const [selectedSlug, setSelectedSlug] = useState<string>('');

  const selected = useMemo(
    () => (health ?? []).find((p) => p.projectSlug === selectedSlug) ?? null,
    [health, selectedSlug],
  );

  const cycleProjectId = useMemo(() => {
    if (!selectedSlug) return undefined;
    // The /projects/health endpoint exposes slug only — leave the cycle-time
    // query unscoped (org-wide) when no project is selected. Per-project cycle
    // time UI ships once /projects/health adds projectId to its row.
    return undefined;
  }, [selectedSlug]);

  const { data: cycleTime, isLoading: cLoading } = useCycleTime(cycleProjectId);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-on-surface">Pipeline Progress</h1>
        <p className="mt-1 text-xs text-outline">
          How issues are flowing through the status pipeline. Click a project to drill in.
        </p>
      </div>

      {/* Project picker */}
      {(health ?? []).length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSelectedSlug('')}
            className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded-sm border ${
              selectedSlug === ''
                ? 'border-primary bg-primary text-on-primary'
                : 'border-outline-variant/30 text-on-surface-variant hover:bg-surface-container-low'
            }`}
          >
            All projects
          </button>
          {(health ?? []).map((p) => (
            <button
              key={p.projectSlug}
              type="button"
              onClick={() => setSelectedSlug(p.projectSlug)}
              className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded-sm border ${
                selectedSlug === p.projectSlug
                  ? 'border-primary bg-primary text-on-primary'
                  : 'border-outline-variant/30 text-on-surface-variant hover:bg-surface-container-low'
              }`}
            >
              {p.projectSlug}
            </button>
          ))}
        </div>
      )}

      {/* Funnel cards */}
      {hLoading ? (
        <div className="h-64 animate-pulse rounded bg-surface-container-high/30" />
      ) : selected ? (
        <FunnelCard project={selected} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(health ?? []).map((p) => (
            <FunnelCard key={p.projectSlug} project={p} compact />
          ))}
        </div>
      )}

      {/* Cycle time chart */}
      <ChartPanel
        title={`Cycle time per stage${selected ? ` — ${selected.projectName}` : ' — all projects'}`}
        subtitle="Average hours an issue spent in each status before moving on (all-time)"
      >
        {cLoading ? (
          <div className="h-64 animate-pulse rounded bg-surface-container-high/30" />
        ) : !cycleTime || cycleTime.length === 0 ? (
          <p className="py-12 text-center text-xs text-outline">
            No status transitions yet — cycle time appears after issues start moving.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={cycleTime}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" />
              <XAxis dataKey="status" tick={{ fontSize: 10 }} />
              <YAxis
                tick={{ fontSize: 10 }}
                label={{
                  value: 'avg hours',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 10, fill: '#94a3b8' },
                }}
              />
              <Tooltip
                contentStyle={{ background: 'rgba(15,23,42,0.95)', border: 'none' }}
                formatter={(value) => [
                  typeof value === 'number' ? `${value.toFixed(1)}h` : String(value),
                  'Avg',
                ]}
              />
              <Bar dataKey="avgHours" fill="#3b82f6" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartPanel>
    </div>
  );
}

function FunnelCard({ project, compact }: { project: ProjectHealthRow; compact?: boolean }) {
  const dist = project.statusDistribution;
  const stages = STAGES.map((s) => ({ status: s, count: dist[s] ?? 0 }));
  const max = Math.max(1, ...stages.map((s) => s.count));

  return (
    <div className="rounded-sm border border-outline-variant/30 bg-surface-container-low overflow-hidden">
      <header className="border-b border-outline-variant/20 px-4 py-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-on-surface">{project.projectName}</h3>
          <p className="text-[10px] text-outline">
            {project.totalActive} active · {project.throughput} closed (7d)
          </p>
        </div>
      </header>
      <div className={`p-4 space-y-1 ${compact ? '' : 'space-y-2'}`}>
        {stages.map((s) => (
          <div key={s.status} className="flex items-center gap-3">
            <span
              className={`text-[10px] uppercase tracking-widest font-bold w-24 truncate ${
                s.count === 0 ? 'text-outline/50' : 'text-on-surface-variant'
              }`}
            >
              {s.status.replace('_', ' ')}
            </span>
            <div className="flex-1 h-3 bg-surface-container-high rounded-sm overflow-hidden">
              <div
                className="h-full transition-all"
                style={{
                  width: `${(s.count / max) * 100}%`,
                  background: STAGE_COLORS[s.status] ?? '#64748b',
                }}
              />
            </div>
            <span
              className={`text-xs font-mono w-8 text-right ${
                s.count === 0 ? 'text-outline/50' : 'text-on-surface'
              }`}
            >
              {s.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartPanel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-sm border border-outline-variant/30 bg-surface-container-low">
      <header className="border-b border-outline-variant/20 px-4 py-3">
        <h2 className="text-[10px] uppercase tracking-[0.15em] font-bold text-on-surface-variant">
          {title}
        </h2>
        {subtitle && <p className="mt-0.5 text-[10px] text-outline">{subtitle}</p>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export default PipelineProgressDashboard;
