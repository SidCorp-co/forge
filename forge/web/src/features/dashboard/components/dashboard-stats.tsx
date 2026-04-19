'use client';

import { StatCard } from '@/components/ui/stat-card';
import { useAllIssues } from '@/features/issue/hooks/use-issues';
import { useUsageSummary } from '@/features/usage/hooks/use-usage';
import { useMemo } from 'react';

const TERMINAL_STATUSES = new Set(['released', 'closed', 'draft']);
const WEEK_MS = 7 * 86_400_000;

interface DashboardStatsProps {
  projectSlug: string;
  attentionCount: number;
}

export function DashboardStats({ projectSlug, attentionCount }: DashboardStatsProps) {
  const { data: issuesData } = useAllIssues(projectSlug);
  const { data: usageData } = useUsageSummary(7);

  const issues = issuesData?.data ?? [];

  const { inPipeline, releasedThisWeek } = useMemo(() => {
    const now = Date.now();
    let inPipeline = 0;
    let releasedThisWeek = 0;

    for (const issue of issues) {
      if (!TERMINAL_STATUSES.has(issue.status)) inPipeline++;
      if ((issue.status === 'released' || issue.status === 'closed') && now - new Date(issue.updatedAt).getTime() < WEEK_MS) {
        releasedThisWeek++;
      }
    }
    return { inPipeline, releasedThisWeek };
  }, [issues]);

  const weeklyCost = usageData?.totals?.estimatedCost ?? 0;

  return (
    <div className="grid grid-cols-2 gap-2">
      <StatCard
        label="Needs Attention"
        value={attentionCount}
        accent={attentionCount > 0 ? 'text-warning' : 'text-primary'}
      />
      <StatCard label="In Pipeline" value={inPipeline} />
      <StatCard label="Released / Week" value={releasedThisWeek} />
      <StatCard label="Weekly Cost" value={`$${weeklyCost.toFixed(2)}`} />
    </div>
  );
}
