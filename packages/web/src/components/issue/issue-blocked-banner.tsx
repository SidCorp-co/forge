'use client';

import { AlertTriangle } from 'lucide-react';
import { useQueries } from '@tanstack/react-query';
import { useIssueRelations } from '@/features/issue/hooks/use-issue-relations';
import { issueKeys } from '@/features/issue/hooks/use-issues';
import { issueApi } from '@/features/issue/api/issue-api';

interface IssueBlockedBannerProps {
  issueId: string;
}

const CLOSED_STATUSES = ['released', 'closed'];

export function IssueBlockedBanner({ issueId }: IssueBlockedBannerProps) {
  const relations = useIssueRelations(issueId);
  const blockerEdges = relations.groups.blocks.incoming;

  const blockerQueries = useQueries({
    queries: blockerEdges.map((edge) => ({
      queryKey: issueKeys.detail(edge.fromIssueId),
      queryFn: () => issueApi.get(edge.fromIssueId),
      enabled: !!edge.fromIssueId,
    })),
  });

  const open = blockerQueries
    .map((q, i) => ({
      edge: blockerEdges[i],
      issue: q.data,
    }))
    .filter(
      (b) =>
        !!b.issue &&
        !CLOSED_STATUSES.includes(b.issue.status as string),
    );

  if (open.length === 0) return null;

  const first = open[0];
  const others = open.length - 1;
  const firstDisplay = first.issue!.displayId;
  const firstStatus = first.issue!.status as string;

  function handleClick() {
    document
      .getElementById('issue-relations')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Scroll to relations"
      className="flex w-full items-start gap-2 rounded-sm border border-amber-500/40 bg-amber-500/15 px-4 py-3 text-left text-amber-400 transition-colors hover:bg-amber-500/25"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="text-sm">
        Blocked by <span className="font-mono text-xs">{firstDisplay}</span>{' '}
        (status: {firstStatus})
        {others > 0 && <> and {others} other(s)</>}
      </span>
    </button>
  );
}
