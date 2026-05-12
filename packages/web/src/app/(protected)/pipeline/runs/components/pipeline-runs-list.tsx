'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Button, Skeleton } from '@/components/ui';
import { useProjects } from '@/features/project/hooks/use-projects';
import { useProjectPipelineRuns } from '@/features/pipeline-run/hooks/use-pipeline-runs';
import {
  PIPELINE_RUN_STATUSES,
  type PipelineRunListItem,
  type PipelineRunStatus,
} from '@/features/pipeline-run/types';
import { formatApiError } from '@/lib/api/error';
import { projectRoom } from '@/lib/ws/rooms';
import { useRoom } from '@/lib/ws/use-room';

type StatusFilter = PipelineRunStatus | 'all';

const STATUS_FILTERS: StatusFilter[] = ['all', ...PIPELINE_RUN_STATUSES];

const STATUS_PILL: Record<PipelineRunStatus, string> = {
  running: 'bg-primary/15 text-primary border-primary/30',
  paused: 'bg-amber-500/15 text-amber-400 border-amber-500/40',
  completed: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40',
  failed: 'bg-error/15 text-error border-error/40',
  cancelled: 'bg-surface-container border-outline-variant/30 text-outline-variant',
};

const moneyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
});

const PAGE_SIZE = 25;

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function PipelineRunsList() {
  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? [];
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [offset, setOffset] = useState(0);

  const effectiveProjectId = projectId ?? projects[0]?.id;

  useRoom(effectiveProjectId ? projectRoom(effectiveProjectId) : null);

  const runsQuery = useProjectPipelineRuns({
    projectId: effectiveProjectId ?? '',
    status: status === 'all' ? undefined : status,
    limit: PAGE_SIZE,
    offset,
  });

  const items = runsQuery.data?.items ?? [];
  const total = runsQuery.data?.totalCount ?? 0;
  const hasMore = offset + items.length < total;

  const projectBySlug = useMemo(() => {
    const m = new Map<string, { slug: string; name: string }>();
    for (const p of projects) m.set(p.id, { slug: p.slug, name: p.name });
    return m;
  }, [projects]);

  function selectStatus(next: StatusFilter) {
    if (next === status) return;
    setStatus(next);
    setOffset(0);
  }

  function selectProject(next: string) {
    setProjectId(next);
    setOffset(0);
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-8 sm:px-8">
      <header className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-primary">Pipeline runs</h1>
          <Link
            href="/pipeline"
            className="text-[10px] uppercase tracking-widest text-on-surface-variant hover:underline"
          >
            ← Back to monitor
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[10px] font-bold uppercase tracking-widest text-outline">
            Project
          </label>
          <select
            value={effectiveProjectId ?? ''}
            onChange={(e) => selectProject(e.target.value)}
            className="rounded-sm border border-outline-variant/30 bg-surface-container-low px-2 py-1 text-xs text-on-surface"
            disabled={projects.length === 0}
          >
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => selectStatus(s)}
              className={
                s === status
                  ? 'rounded-sm border border-primary bg-primary/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-primary'
                  : 'rounded-sm border border-outline-variant/30 bg-surface-container px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-high'
              }
            >
              {s}
            </button>
          ))}
        </div>
      </header>

      <section>
        {runsQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : runsQuery.error ? (
          <p className="text-[10px] uppercase tracking-widest text-error">
            {formatApiError(runsQuery.error)}
          </p>
        ) : items.length === 0 ? (
          <p className="text-[11px] text-outline">No pipeline runs match.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((run) => (
              <li key={run.id}>
                <RunCard run={run} slug={projectBySlug.get(run.projectId)?.slug} />
              </li>
            ))}
          </ul>
        )}

        {hasMore && (
          <div className="mt-3 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={runsQuery.isFetching}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {runsQuery.isFetching ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

function RunCard({
  run,
  slug,
}: {
  run: PipelineRunListItem;
  slug: string | undefined;
}) {
  const issueHref = slug && run.issueId ? `/projects/${slug}/issues/${run.issueId}` : null;
  return (
    <div className="rounded-sm border border-outline-variant/20 bg-surface p-3 hover:bg-surface-container-low">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${STATUS_PILL[run.status]}`}
          >
            {run.status}
          </span>
          <span className="text-[10px] font-bold uppercase tracking-widest text-outline">
            {run.kind}
          </span>
          {run.currentStep && (
            <span className="font-mono text-xs text-on-surface-variant">
              {run.currentStep}
            </span>
          )}
        </div>
        <span className="font-mono text-[10px] uppercase tracking-widest text-outline">
          {timeAgo(run.startedAt)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs">
        {issueHref ? (
          <Link
            href={issueHref}
            className="font-mono text-primary hover:underline"
          >
            Open issue
          </Link>
        ) : (
          <span className="text-outline">project-scoped run</span>
        )}
        <span className="font-mono text-on-surface">
          {moneyFmt.format(run.cost.estimatedCost)}
        </span>
      </div>
    </div>
  );
}

export default PipelineRunsList;
