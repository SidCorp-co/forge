'use client';

import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { useIssueSearch, useTransitionIssue } from '@/features/issue/hooks/use-issues';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { useChangedIds } from '@/hooks/use-changed-ids';
import { useToast } from '@/hooks/use-toast';
import { formatApiError } from '@/lib/api/error';
import type { Issue } from '@forge/contracts';
import { DEFAULT_VISIBLE } from '../constants';
import type { IssueStatus } from '@/features/issue/types';

/**
 * Board view: one search-call fetches all issues for the visible statuses
 * (core's `/projects/:id/issues/search` supports repeated `status` params).
 * Transitions happen via the dedicated transition endpoint, not a PATCH —
 * the state machine rejects illegal moves with a 409.
 */
export function useBoard() {
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);
  const projectId = project?.id;

  const [viewMode, setViewMode] = useState<'issues' | 'tasks'>('issues');
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [visibleCols, setVisibleCols] = useState<Record<IssueStatus, boolean>>(
    DEFAULT_VISIBLE,
  );
  const [showColPicker, setShowColPicker] = useState(false);
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  const visibleStatuses = Object.entries(visibleCols)
    .filter(([, v]) => v)
    .map(([k]) => k);

  const { data, isLoading } = useIssueSearch({
    projectId: projectId ?? '',
    status: visibleStatuses,
    limit: 200,
  });

  const issues: Issue[] = data?.items ?? [];

  const transitionIssue = useTransitionIssue();
  const { toasts, addToast } = useToast();

  // useChangedIds predates the core rewire; adapt the new Issue shape onto
  // the old { id: number, documentId, status, updatedAt } signature so we
  // can keep the highlight-on-change behaviour without rewriting the hook.
  const changedIssueIds = useChangedIds(
    issues.map((i) => ({
      id: 0,
      documentId: i.id,
      status: i.status,
      updatedAt: String(i.updatedAt ?? ''),
    })),
  );

  const handleIssueDrop = useCallback(
    (issueId: string, status: string) => {
      transitionIssue.mutate(
        { id: issueId, toStatus: status },
        {
          onError: (err) => addToast(formatApiError(err)),
        },
      );
    },
    [transitionIssue, addToast],
  );

  const toggleCol = (status: IssueStatus) => {
    setVisibleCols((prev) => ({ ...prev, [status]: !prev[status] }));
  };

  return {
    viewMode,
    setViewMode,
    loading: isLoading,
    issues,
    selectedIssueId,
    setSelectedIssueId,
    changedIssueIds,
    visibleCols,
    showColPicker,
    setShowColPicker,
    toggleCol,
    handleIssueDrop,
    // Tasks view is out of scope for F2 — core has no tasks endpoint yet.
    tasks: [] as unknown[],
    filteredTasks: [] as unknown[],
    changedTaskIds: new Set<string>(),
    assignees: [] as string[],
    assigneeFilter,
    setAssigneeFilter,
    agentFilter,
    setAgentFilter,
    handleTaskDrop: () => {},
    toasts,
  };
}
