import { useMemo } from 'react';
import { useGateIssues } from '@/features/issue/hooks/use-issues';
import type { Issue, IssueStatus } from '@/features/issue/types';

export interface AttentionGroup {
  key: string;
  label: string;
  approveLabel: string;
  approveStatus: IssueStatus;
  rejectLabel: string;
  rejectStatus: IssueStatus;
  issues: Issue[];
  count: number;
}

const GATE_CONFIG: {
  key: string;
  status: IssueStatus;
  label: string;
  approveLabel: string;
  approveStatus: IssueStatus;
  rejectLabel: string;
  rejectStatus: IssueStatus;
}[] = [
  { key: 'planReview', status: 'waiting', label: 'Plan Review', approveLabel: 'Approve Plan', approveStatus: 'approved', rejectLabel: 'Request Changes', rejectStatus: 'needs_info' },
  { key: 'codeReview', status: 'developed', label: 'Code Review', approveLabel: 'Approve & Deploy', approveStatus: 'deploying', rejectLabel: 'Reject', rejectStatus: 'reopen' },
  { key: 'releaseApproval', status: 'staging', label: 'Release Approval', approveLabel: 'Release', approveStatus: 'released', rejectLabel: 'Reject', rejectStatus: 'reopen' },
  { key: 'needsInfo', status: 'needs_info', label: 'Needs Info', approveLabel: 'Resolve', approveStatus: 'confirmed', rejectLabel: 'Close', rejectStatus: 'closed' },
  { key: 'onHold', status: 'on_hold', label: 'On Hold', approveLabel: 'Resume', approveStatus: 'open', rejectLabel: 'Close', rejectStatus: 'closed' },
];

export function getTimeInStatus(issue: Issue): number {
  if (!issue.changeHistory?.length) return Date.now() - new Date(issue.updatedAt).getTime();
  const last = issue.changeHistory[issue.changeHistory.length - 1] as unknown;
  let at: string | undefined;
  if (typeof last === 'string') {
    // Format: "[2026-03-25T10:49:12.740Z] Actor changed..."
    const match = last.match(/^\[([^\]]+)\]/);
    at = match?.[1];
  } else if (last && typeof last === 'object' && 'at' in last) {
    at = (last as { at: string }).at;
  }
  if (!at) return Date.now() - new Date(issue.updatedAt).getTime();
  const parsed = new Date(at).getTime();
  if (isNaN(parsed)) return Date.now() - new Date(issue.updatedAt).getTime();
  return Date.now() - parsed;
}

export function useAttentionQueue(projectSlug?: string) {
  const { data, isLoading } = useGateIssues(projectSlug);
  const issues = data?.data ?? [];

  const groups = useMemo(() => {
    return GATE_CONFIG.map((cfg) => {
      const matching = issues.filter((i) => i.status === cfg.status);
      return {
        key: cfg.key,
        label: cfg.label,
        approveLabel: cfg.approveLabel,
        approveStatus: cfg.approveStatus,
        rejectLabel: cfg.rejectLabel,
        rejectStatus: cfg.rejectStatus,
        issues: matching.sort((a, b) => getTimeInStatus(b) - getTimeInStatus(a)),
        count: matching.length,
      } satisfies AttentionGroup;
    }).filter((g) => g.count > 0);
  }, [issues]);

  const totalCount = useMemo(() => groups.reduce((s, g) => s + g.count, 0), [groups]);

  return { groups, totalCount, isLoading, allIssues: issues };
}
