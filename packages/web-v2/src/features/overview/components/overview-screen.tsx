'use client';

// The workspace landing = workspace dashboard (ISS-355, reshaped in ISS-665).
// Replaces the old flat project list with a dense, actionable overview built
// ENTIRELY from existing + new hooks, so the WS event-router invalidations
// that already drive `['projects']`, `['projects','health']`, `['attention']`,
// and `['recent-changes']` keep every widget live with no bespoke wiring:
//   • KPI row            — workspace totals + health rollups
//   • Needs-attention    — cross-project inbox digest (false positives fixed
//                          server-side; see attention-routes.ts)
//   • Work distribution  — per-project top-N workload (which project is
//                          overloaded), absorbing the removed Spotlight panel's
//                          project-level signal
//   • Recent changes     — recently-updated issues (status transitions),
//                          replacing the raw cross-project chat-log feed
//
// Zero projects → an onboarding empty state with a New-project CTA (the create
// dialog itself lives on /projects, reached via ?new=1).
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState, ErrorState, PageContainer, ProjectCardSkeleton } from '@/design';
import { useAttention } from '@/features/attention/hooks';
import type { AttentionItem } from '@/features/attention/types';
import { useActiveOrg } from '@/features/orgs/active-org';
import { workspaceTotals } from '@/features/projects/derive';
import { useProjectHealth, useProjectsConsole } from '@/features/projects/hooks';
import { useRecentChanges } from '@/features/recent-changes/hooks';
import { formatApiError } from '@/lib/api/error';
import { perProjectWorkload, workspaceKpis } from '../derive';
import { AttentionPanel } from './attention-panel';
import { KpiRow } from './kpi-row';
import { RecentChanges } from './recent-changes';
import { WorkDistribution } from './work-distribution';

const WORKLOAD_LIMIT = 5;
const RECENT_CHANGES_LIMIT = 12;
// The core route (`packages/core/src/me/recent-changes-routes.ts`) caps
// `limit` at 60 — keep this over-fetch multiplier's product at or under that,
// bump both sides together if either changes.
const RECENT_CHANGES_FETCH_LIMIT = RECENT_CHANGES_LIMIT * 5;

export function OverviewScreen() {
  const router = useRouter();
  const { items: allItems, isLoading, isError, error, refetch } = useProjectsConsole();
  const health = useProjectHealth();
  const attention = useAttention();
  // Hard-scope the dashboard to the active org (ISS-470) so `/` isn't an
  // implicit "all organizations" view that contradicts the org-centric model.
  // null activeOrgId only while orgs load → show all for one tick.
  const { activeOrg, activeOrgId } = useActiveOrg();
  const items = useMemo(
    () => allItems.filter((p) => !activeOrgId || p.orgId === activeOrgId),
    [allItems, activeOrgId],
  );
  const totals = useMemo(() => workspaceTotals(items), [items]);
  // Health rollups are per-project — scope them to the in-scope project ids so
  // KPIs + work distribution reflect the active org only.
  const scopedHealth = useMemo(() => {
    if (!health.data) return health.data;
    const ids = new Set(items.map((p) => p.id));
    return health.data.filter((r) => ids.has(r.id));
  }, [health.data, items]);
  const orgLabel = activeOrg ? (activeOrg.isPersonal ? 'Personal' : activeOrg.name) : null;
  // Slugs of the in-scope projects — drives client-side org-scoping of the
  // Attention + Recent-changes panels below (ISS-476). Both payloads carry a
  // `projectSlug`, so we filter by this set instead of refetching; the set
  // changes whenever `activeOrgId` flips, so the switch re-scopes live.
  const scopedSlugs = useMemo(() => new Set(items.map((p) => p.slug)), [items]);
  // Over-fetch then client-filter+slice: the endpoint is cross-project and not
  // org-scoped, so a single-page fetch at RECENT_CHANGES_LIMIT could be
  // entirely other orgs. The key stays under `['recent-changes']`, which the
  // event-router invalidates on issue events, so live refresh is preserved.
  const recentChanges = useRecentChanges(RECENT_CHANGES_FETCH_LIMIT);

  // Relative timestamps: 0 on server + first paint ("just now"), real clock
  // after mount — hydration-safe (mirrors ProjectsConsole).
  const [now, setNow] = useState(0);
  useEffect(() => setNow(Date.now()), []);

  const kpis = useMemo(
    () => workspaceKpis(totals, items, scopedHealth),
    [totals, items, scopedHealth],
  );
  const workloads = useMemo(
    () => perProjectWorkload(items, scopedHealth, WORKLOAD_LIMIT),
    [items, scopedHealth],
  );
  // Scope "Needs attention" to the active org: keep only items whose project is
  // in scope. Slug-less items (offline runners) are workspace-level infra with
  // no project association on the client, so they stay. Recompute `total` from
  // the filtered buckets so the panel header matches what it shows.
  const scopedAttention = useMemo(() => {
    const v = attention.view;
    const keep = (it: AttentionItem) => !it.projectSlug || scopedSlugs.has(it.projectSlug);
    const needsReview = v.needsReview.filter(keep);
    const awaitingInput = v.awaitingInput.filter(keep);
    const mentions = v.mentions.filter(keep);
    const failedJobs = v.failedJobs.filter(keep);
    const offlineRunners = v.offlineRunners;
    return {
      needsReview,
      awaitingInput,
      mentions,
      failedJobs,
      offlineRunners,
      total:
        needsReview.length +
        awaitingInput.length +
        mentions.length +
        failedJobs.length +
        offlineRunners.length,
    };
  }, [attention.view, scopedSlugs]);
  const recentChangeRows = useMemo(
    () => recentChanges.items.filter((r) => scopedSlugs.has(r.projectSlug)).slice(0, RECENT_CHANGES_LIMIT),
    [recentChanges.items, scopedSlugs],
  );

  const openProject = (slug: string) => router.push(`/projects/${slug}`);

  if (isError) {
    return (
      <PageContainer>
        <ErrorState
          title="Couldn't load your workspace"
          message={formatApiError(error)}
          onRetry={() => refetch()}
        />
      </PageContainer>
    );
  }

  if (isLoading) {
    return (
      <PageContainer>
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(326px,1fr))]">
          {Array.from({ length: 6 }).map((_, i) => (
            // eslint-disable-next-line react/no-array-index-key -- static skeletons
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      </PageContainer>
    );
  }

  if (items.length === 0) {
    // Distinguish a brand-new workspace (no projects anywhere) from an active
    // org that simply has none yet (other orgs may hold projects).
    const hasAnyProjects = allItems.length > 0;
    return (
      <PageContainer className="grid min-h-[60vh] place-items-center">
        <EmptyState
          title={hasAnyProjects ? `No projects in ${orgLabel ?? 'this organization'} yet` : 'Welcome to Forge'}
          message={
            hasAnyProjects
              ? 'Create a project in this organization, or switch organizations from the chrome to see others.'
              : 'Create your first project to start shipping issues through the pipeline. Your workspace dashboard fills in as work flows.'
          }
          action={{ label: 'New project', onClick: () => router.push('/projects?new=1') }}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="fg-h2">Overview{orgLabel ? ` · ${orgLabel}` : ''}</h1>
          <p className="fg-body-sm mt-0.5 text-muted">
            Everything that needs you across {orgLabel ?? 'your organization'}.
          </p>
        </div>
      </header>

      <KpiRow kpis={kpis} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <AttentionPanel
            view={scopedAttention}
            now={now}
            onOpen={(link) => router.push(link)}
            onViewAll={() => router.push('/attention')}
          />
        </div>
        <div className="lg:col-span-5">
          <WorkDistribution workloads={workloads} onOpen={openProject} onViewAll={() => router.push('/projects')} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-12">
          <RecentChanges
            items={recentChangeRows}
            now={now}
            isLoading={recentChanges.isLoading}
            isError={recentChanges.isError}
            error={recentChanges.error}
            onOpen={(slug, id) => router.push(`/projects/${slug}/issues/${id}`)}
            onRetry={() => recentChanges.refetch()}
          />
        </div>
      </div>
    </PageContainer>
  );
}
