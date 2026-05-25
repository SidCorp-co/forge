'use client';

import { useParams } from 'next/navigation';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useCostSummary } from '@/features/analytics/hooks/use-cost-summary';
import { useCostTrend } from '@/features/analytics/hooks/use-cost-trend';
import { useOutliers } from '@/features/analytics/hooks/use-outliers';
import {
  CostOverviewCard,
  CostTrendChart,
  OutliersTable,
} from '@/features/analytics/components';

const MIN_JOBS_FOR_INSIGHTS = 5;

export default function InsightsPage() {
  useSetPageTitle('Insights');
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);
  const projectId = project?.id;

  const summary = useCostSummary(projectId, 30);
  const trend = useCostTrend(projectId, 90);
  const outliers = useOutliers(projectId, 30);

  if (!project) {
    return (
      <div className="p-6">
        <p className="text-sm text-on-surface-variant">Loading project…</p>
      </div>
    );
  }

  const totalRuns = (summary.data?.byState ?? []).reduce((acc, r) => acc + r.runs, 0);
  const isEmpty = summary.isSuccess && totalRuns < MIN_JOBS_FOR_INSIGHTS;

  return (
    <div className="p-6 space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-on-surface">Insights</h1>
        <p className="mt-1 text-xs text-outline">
          Pipeline cost overview, daily trend, and outlier runs for {project.name}.
        </p>
      </header>

      {isEmpty ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CostOverviewCard query={summary} />
            <CostTrendChart query={trend} />
          </div>
          <OutliersTable query={outliers} projectSlug={slug} />
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <section className="rounded-sm border border-outline-variant/30 bg-surface-container-low p-8 text-center">
      <p className="text-sm text-on-surface-variant">
        No data yet (need ≥{MIN_JOBS_FOR_INSIGHTS} jobs in window).
      </p>
      <p className="mt-2 text-[11px] text-outline">
        Run the pipeline on a few issues, then check back for cost insights.
      </p>
    </section>
  );
}
