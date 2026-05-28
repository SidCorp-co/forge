'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, Workflow } from 'lucide-react';
import { useProjectBySlug, useProjectsHealth } from '@/features/project/hooks/use-projects';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { ALL_STATUSES, STATUS_COLORS } from '@/lib/constants';
import { formatApiError } from '@/lib/api/error';
import type { IssueStatus } from '@/features/issue/types';
import { AttentionQueue } from './attention-queue';
import { PipelineFeed } from './pipeline-feed';
import { PipelineActivityPanel } from './pipeline-activity-panel';
import { usePipelineActivity } from '../hooks/use-pipeline-activity';
import { CostVelocityPanel } from './cost-velocity-panel';
import { ContinueSetupBanner } from './continue-setup-banner';
import { ProjectOnboardingChecklist } from './project-onboarding-checklist';
import { projectRoom } from '@/lib/ws/rooms';
import { useRoom } from '@/lib/ws/use-room';

export function ProjectDashboard() {
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);
  const { data, isLoading, error } = useProjectsHealth();
  const { running, queued, recentCompleted, isLoading: pipelineLoading } = usePipelineActivity(slug);

  // Live job/pipeline-run updates: the WS router invalidates ['jobs','list'] /
  // ['pipeline-runs','list'] on job.* and pipeline_run.status_changed events.
  useRoom(project ? projectRoom(project.id) : null);

  const row = data?.find((r) => r.projectSlug === slug);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-sm border border-error/30 bg-error-container/10 p-4 text-sm text-error">
        {formatApiError(error)}
      </div>
    );
  }

  const totalIssues = row
    ? Object.values(row.statusDistribution).reduce((a, b) => a + b, 0)
    : 0;
  const isBrandNew = !!project && totalIssues === 0 && !project.repoPath;

  if (isBrandNew) {
    return (
      <div className="space-y-3">
        <ContinueSetupBanner slug={slug} projectId={project?.id} />
        <ProjectOnboardingChecklist slug={slug} projectId={project?.id} />
      </div>
    );
  }

  if (!row) {
    return (
      <div className="space-y-3">
        <ContinueSetupBanner slug={slug} projectId={project?.id} />
        <ProjectOnboardingChecklist slug={slug} projectId={project?.id} />
      </div>
    );
  }

  const distEntries = ALL_STATUSES
    .map((s) => ({ status: s.value, label: s.label, count: row.statusDistribution[s.value] ?? 0 }))
    .filter((e) => e.count > 0);

  const hasPipelineActivity =
    running.length + queued.length + recentCompleted.length > 0;

  return (
    <div className="space-y-6">
      <ContinueSetupBanner slug={slug} projectId={project?.id} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Active issues" value={row.totalActive} />
        <StatCard label="Throughput (7d)" value={row.throughput} sub="closed or released" />
        <StatCard
          label="Pending escalations"
          value={row.pendingEscalations}
          accent={row.pendingEscalations > 0 ? 'text-warning' : undefined}
        />
      </div>

      {project && <PipelineActivityPanel projectId={project.id} slug={slug} />}

      {(pipelineLoading || hasPipelineActivity) && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            <Workflow className="h-3.5 w-3.5" />
            Pipeline in-flight
          </h2>
          {pipelineLoading ? (
            <Skeleton className="h-24" />
          ) : (
            <PipelineFeed
              running={running}
              queued={queued}
              recentCompleted={recentCompleted}
            />
          )}
        </section>
      )}

      <AttentionQueue />

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            Status distribution
          </h2>
          <span className="text-[10px] uppercase tracking-widest text-outline">
            {totalIssues} total
          </span>
        </div>
        {totalIssues === 0 ? (
          <p className="text-xs text-outline">No issues yet.</p>
        ) : (
          <>
            <div className="flex h-2 w-full overflow-hidden rounded-sm bg-surface-container-high">
              {distEntries.map((e) => (
                <div
                  key={e.status}
                  className={STATUS_COLORS[e.status as IssueStatus] ?? 'bg-outline-variant'}
                  style={{ width: `${(e.count / totalIssues) * 100}%` }}
                  title={`${e.label}: ${e.count}`}
                />
              ))}
            </div>
            <ul className="flex flex-wrap gap-2 text-[10px] uppercase tracking-widest">
              {distEntries.map((e) => (
                <li
                  key={e.status}
                  className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 ${STATUS_COLORS[e.status as IssueStatus] ?? 'bg-outline-variant text-outline'}`}
                >
                  <span>{e.label}</span>
                  <span className="font-bold tabular-nums">{e.count}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          <AlertTriangle className="h-3.5 w-3.5" />
          Blockers
        </h2>
        {row.blockers.length === 0 ? (
          <p className="text-xs text-outline">No blockers right now.</p>
        ) : (
          <ul className="divide-y divide-outline-variant/20 rounded-sm border border-outline-variant/20 bg-surface-container-low">
            {row.blockers.map((b) => (
              <li key={b.documentId}>
                <Link
                  href={`/projects/${slug}/issues/${b.documentId}`}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-surface-container-high"
                >
                  <span className="font-mono tracking-widest text-primary">{b.issueId}</span>
                  <span
                    className={`inline-flex rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${STATUS_COLORS[b.status as IssueStatus] ?? 'bg-outline-variant text-outline'}`}
                  >
                    {b.status.replace('_', ' ')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {project && <CostVelocityPanel projectId={project.id} />}
    </div>
  );
}

export default ProjectDashboard;
