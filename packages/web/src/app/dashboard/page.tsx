'use client';

import Link from 'next/link';
import { Activity, AlertTriangle, FolderKanban, TrendingUp } from 'lucide-react';
import { Shell } from '@/components/layout/shell';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useProjectsHealth } from '@/features/project/hooks/use-projects';
import { AttentionQueue } from '@/features/dashboard/components/attention-queue';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { STATUS_COLORS } from '@/lib/constants';
import { formatApiError } from '@/lib/api/error';
import type { IssueStatus } from '@/features/issue/types';

export default function DashboardPage() {
  useSetPageTitle('Dashboard');
  const { data, isLoading, error } = useProjectsHealth();

  return (
    <Shell>
      <div className="p-6 space-y-6">
        <header className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
          <span className="text-[10px] uppercase tracking-widest text-outline">
            Cross-project view
          </span>
        </header>

        {isLoading && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
            <Skeleton className="h-32" />
          </>
        )}

        {error && (
          <div className="rounded-sm border border-error/30 bg-error-container/10 p-4 text-sm text-error">
            {formatApiError(error)}
          </div>
        )}

        {!isLoading && !error && (!data || data.length === 0) && (
          <div className="space-y-3">
            <EmptyState
              icon={<FolderKanban className="h-8 w-8" />}
              title="No projects yet"
              description="Create or join a project to see its health here."
            />
            <div className="flex justify-center">
              <Link
                href="/projects?new=1"
                className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs font-medium uppercase tracking-widest text-on-primary hover:opacity-90"
              >
                New Project
              </Link>
            </div>
          </div>
        )}

        {!isLoading && !error && data && data.length > 0 && (
          <DashboardBody rows={data} />
        )}
      </div>
    </Shell>
  );
}

type Row = NonNullable<ReturnType<typeof useProjectsHealth>['data']>[number];

function DashboardBody({ rows }: { rows: Row[] }) {
  const totals = rows.reduce(
    (acc, r) => {
      acc.active += r.totalActive;
      acc.throughput += r.throughput;
      acc.escalations += r.pendingEscalations;
      acc.blockers += r.blockers.length;
      return acc;
    },
    { active: 0, throughput: 0, escalations: 0, blockers: 0 },
  );

  const allBlockers = rows
    .flatMap((r) =>
      r.blockers.map((b) => ({ ...b, projectSlug: r.projectSlug, projectName: r.projectName })),
    )
    .slice(0, 8);

  return (
    <>
      <AttentionQueue />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Projects" value={rows.length} />
        <StatCard label="Active issues" value={totals.active} />
        <StatCard
          label="Throughput (7d)"
          value={totals.throughput}
          sub="closed or released"
        />
        <StatCard
          label="Escalations"
          value={totals.escalations}
          accent={totals.escalations > 0 ? 'text-warning' : undefined}
        />
      </div>

      <section className="space-y-2">
        <h2 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          <TrendingUp className="h-3.5 w-3.5" />
          Projects
        </h2>
        <ul className="divide-y divide-outline-variant/20 rounded-sm border border-outline-variant/20 bg-surface-container-low">
          {rows.map((r) => {
            const total = Object.values(r.statusDistribution).reduce((a, b) => a + b, 0);
            return (
              <li key={r.projectSlug}>
                <Link
                  href={`/projects/${r.projectSlug}`}
                  className="grid grid-cols-12 items-center gap-3 px-3 py-2.5 text-xs hover:bg-surface-container-high"
                >
                  <span className="col-span-4 font-medium text-on-surface">
                    {r.projectName}
                  </span>
                  <span className="col-span-2 tabular-nums text-outline">
                    {r.totalActive} active
                  </span>
                  <span className="col-span-2 tabular-nums text-outline">
                    {r.throughput} / 7d
                  </span>
                  <span className="col-span-2 tabular-nums text-outline">
                    {r.blockers.length} blockers
                  </span>
                  <span
                    className={`col-span-2 tabular-nums ${r.pendingEscalations > 0 ? 'text-warning' : 'text-outline'}`}
                  >
                    {r.pendingEscalations} escalations
                  </span>
                  {total > 0 && (
                    <span className="col-span-12 mt-1 flex h-1.5 w-full overflow-hidden rounded-sm bg-surface-container-high">
                      {Object.entries(r.statusDistribution)
                        .filter(([, n]) => n > 0)
                        .map(([s, n]) => (
                          <span
                            key={s}
                            className={STATUS_COLORS[s as IssueStatus] ?? 'bg-outline-variant'}
                            style={{ width: `${(n / total) * 100}%` }}
                            title={`${s}: ${n}`}
                          />
                        ))}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {allBlockers.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            <AlertTriangle className="h-3.5 w-3.5" />
            Blockers across projects
            <span className="ml-auto text-[10px] uppercase tracking-widest text-outline">
              top {allBlockers.length}
            </span>
          </h2>
          <ul className="divide-y divide-outline-variant/20 rounded-sm border border-outline-variant/20 bg-surface-container-low">
            {allBlockers.map((b) => (
              <li key={`${b.projectSlug}-${b.documentId}`}>
                <Link
                  href={`/projects/${b.projectSlug}/issues/${b.documentId}`}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-surface-container-high"
                >
                  <span className="font-mono tracking-widest text-primary">{b.issueId}</span>
                  <span className="flex-1 truncate text-outline">{b.projectName}</span>
                  <span
                    className={`inline-flex rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${STATUS_COLORS[b.status as IssueStatus] ?? 'bg-outline-variant text-outline'}`}
                  >
                    {b.status.replace('_', ' ')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {totals.blockers === 0 && totals.escalations === 0 && (
        <p className="flex items-center gap-2 rounded-sm border border-outline-variant/20 bg-surface-container-low p-3 text-xs text-outline">
          <Activity className="h-3.5 w-3.5" />
          No blockers, no escalations across {rows.length} project{rows.length > 1 ? 's' : ''}.
        </p>
      )}
    </>
  );
}
