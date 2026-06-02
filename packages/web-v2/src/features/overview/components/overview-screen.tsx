'use client';

// The /v2 landing = workspace dashboard (ISS-355). Replaces the old flat
// project list with a dense, actionable overview built ENTIRELY from existing
// hooks (no new API/core changes), so the WS event-router invalidations that
// already drive `['projects']`, `['projects','health']`, `['attention']`, and
// `['chat-logs']` keep every widget live with no bespoke wiring:
//   • KPI row            — workspace totals + health rollups
//   • Needs-attention    — cross-project inbox digest
//   • Work distribution  — aggregated issue statusDistribution
//   • Spotlight projects — ranked/capped subset (the full list lives at /projects)
//   • Recent activity    — last few cross-project agent turns
//
// Zero projects → an onboarding empty state with a New-project CTA (the create
// dialog itself lives on /projects, reached via ?new=1).
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState, ErrorState, ProjectCardSkeleton } from '@/design';
import { useActivity } from '@/features/activity/hooks';
import { useAttention } from '@/features/attention/hooks';
import { useProjectHealth, useProjectsConsole } from '@/features/projects/hooks';
import { formatApiError } from '@/lib/api/error';
import {
  aggregateStatusDistribution,
  groupWorkBuckets,
  pickSpotlightProjects,
  workspaceKpis,
} from '../derive';
import { ActivityFeed } from './activity-feed';
import { AttentionPanel } from './attention-panel';
import { KpiRow } from './kpi-row';
import { SpotlightProjects } from './spotlight-projects';
import { WorkDistribution } from './work-distribution';

const SPOTLIGHT_LIMIT = 6;
const ACTIVITY_LIMIT = 8;

export function OverviewScreen() {
  const router = useRouter();
  const { items, totals, isLoading, isError, error, refetch } = useProjectsConsole();
  const health = useProjectHealth();
  const attention = useAttention();
  // `pageSize` only narrows the page; the key stays under the `['chat-logs']`
  // prefix the event-router invalidates, so live refresh is preserved.
  const activity = useActivity({ pageSize: ACTIVITY_LIMIT });

  // Relative timestamps: 0 on server + first paint ("just now"), real clock
  // after mount — hydration-safe (mirrors ProjectsConsole).
  const [now, setNow] = useState(0);
  useEffect(() => setNow(Date.now()), []);

  const kpis = useMemo(
    () => workspaceKpis(totals, items, health.data),
    [totals, items, health.data],
  );
  const distribution = useMemo(
    () => groupWorkBuckets(aggregateStatusDistribution(health.data)),
    [health.data],
  );
  const spotlight = useMemo(() => pickSpotlightProjects(items, SPOTLIGHT_LIMIT), [items]);
  const activityRows = useMemo(
    () => (activity.data?.items ?? []).slice(0, ACTIVITY_LIMIT),
    [activity.data],
  );

  const openProject = (slug: string) => router.push(`/projects/${slug}`);

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-[1240px] px-6 py-6">
        <ErrorState
          title="Couldn't load your workspace"
          message={formatApiError(error)}
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-[1240px] px-6 py-6">
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(326px,1fr))]">
          {Array.from({ length: 6 }).map((_, i) => (
            // eslint-disable-next-line react/no-array-index-key -- static skeletons
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="mx-auto grid min-h-[60vh] w-full max-w-[1240px] place-items-center px-6 py-6">
        <EmptyState
          title="Welcome to Forge"
          message="Create your first project to start shipping issues through the pipeline. Your workspace dashboard fills in as work flows."
          action={{ label: 'New project', onClick: () => router.push('/projects?new=1') }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="fg-h2">Overview</h1>
          <p className="fg-body-sm mt-0.5 text-muted">
            Everything that needs you, across every project you can see.
          </p>
        </div>
      </header>

      <KpiRow kpis={kpis} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <AttentionPanel
            view={attention.view}
            now={now}
            onOpen={(link) => router.push(link)}
            onViewAll={() => router.push('/attention')}
          />
        </div>
        <div className="lg:col-span-5">
          <WorkDistribution buckets={distribution.buckets} total={distribution.total} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <SpotlightProjects
            projects={spotlight}
            now={now}
            onOpen={openProject}
            onViewAll={() => router.push('/projects')}
          />
        </div>
        <div className="lg:col-span-5">
          <ActivityFeed
            rows={activityRows}
            now={now}
            isLoading={activity.isLoading}
            onOpen={openProject}
            onViewAll={() => router.push('/activity')}
          />
        </div>
      </div>
    </div>
  );
}
