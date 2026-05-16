'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  useIssueSearch,
  usePatchIssue,
  useTransitionIssue,
} from '@/features/issue/hooks/use-issues';
import {
  useProjectBySlug,
  useUpdateProjectBoardConfig,
} from '@/features/project/hooks/use-projects';
import { useUpdateTask } from '@/features/task/hooks/use-tasks';
import { taskApi } from '@/features/task/api/task-api';
import type { Task, TaskStatus } from '@/features/task/types';
import { useChangedIds } from '@/hooks/use-changed-ids';
import { useToast } from '@/hooks/use-toast';
import { formatApiError } from '@/lib/api/error';
import type { Issue } from '@forge/contracts';
import {
  BOARD_DENSITY_KEY,
  boardCollapsedKey,
  boardGroupByKey,
  DEFAULT_VISIBLE,
  type BoardDensity,
  type BoardGroupBy,
} from '../constants';
import type { IssueStatus } from '@/features/issue/types';
import { bucketIssues, rowValueFor, UNGROUPED_ROW_KEY } from './board-grouping';

type IssueRow = Issue & {
  assigneeId?: string | null;
  parentIssueId?: string | null;
  category?: string | null;
};

function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / disabled */
  }
}

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

  const [density, setDensityState] = useState<BoardDensity>('comfortable');
  const [groupByRow, setGroupByRowState] = useState<BoardGroupBy>('none');
  const [collapsedCols, setCollapsedCols] = useState<Partial<Record<IssueStatus, boolean>>>(
    {},
  );

  // Hydrate prefs from localStorage once we know which project we're on.
  useEffect(() => {
    setDensityState(readLocal<BoardDensity>(BOARD_DENSITY_KEY, 'comfortable'));
  }, []);

  useEffect(() => {
    if (!projectId) return;
    setGroupByRowState(readLocal<BoardGroupBy>(boardGroupByKey(projectId), 'none'));
    setCollapsedCols(
      readLocal<Partial<Record<IssueStatus, boolean>>>(boardCollapsedKey(projectId), {}),
    );
  }, [projectId]);

  const setDensity = useCallback((next: BoardDensity) => {
    setDensityState(next);
    writeLocal(BOARD_DENSITY_KEY, next);
  }, []);

  const setGroupByRow = useCallback(
    (next: BoardGroupBy) => {
      setGroupByRowState(next);
      if (projectId) writeLocal(boardGroupByKey(projectId), next);
    },
    [projectId],
  );

  const toggleCollapsedCol = useCallback(
    (status: IssueStatus) => {
      setCollapsedCols((prev) => {
        const next = { ...prev, [status]: !prev[status] };
        if (projectId) writeLocal(boardCollapsedKey(projectId), next);
        return next;
      });
    },
    [projectId],
  );

  const wipLimits = useMemo<Partial<Record<IssueStatus, number>>>(() => {
    const cfg = (project?.agentConfig as Record<string, unknown> | null | undefined) ?? {};
    const boardCfg = (cfg.boardConfig as Record<string, unknown> | undefined) ?? {};
    return (boardCfg.wipLimits as Partial<Record<IssueStatus, number>> | undefined) ?? {};
  }, [project]);

  const updateBoardConfig = useUpdateProjectBoardConfig();

  const visibleStatuses = Object.entries(visibleCols)
    .filter(([, v]) => v)
    .map(([k]) => k);

  const { data, isLoading } = useIssueSearch({
    projectId: projectId ?? '',
    status: visibleStatuses,
    limit: 200,
  });

  const issues: IssueRow[] = (data?.items ?? []) as IssueRow[];

  const transitionIssue = useTransitionIssue();
  const patchIssue = usePatchIssue();
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

  const groupedIssues = useMemo(
    () => bucketIssues(issues, groupByRow),
    [issues, groupByRow],
  );

  const handleIssueDropCell = useCallback(
    (issueId: string, nextStatus: string, nextRowKey: string) => {
      transitionIssue.mutate(
        { id: issueId, toStatus: nextStatus },
        { onError: (err) => addToast(formatApiError(err)) },
      );
      if (groupByRow === 'none') return;
      const issue = issues.find((i) => i.id === issueId);
      if (!issue) return;
      const currentRow = rowValueFor(issue, groupByRow);
      if (currentRow === nextRowKey) return;
      if (groupByRow === 'parent') {
        addToast('Drag between parent rows is not supported yet');
        return;
      }
      const value = nextRowKey === UNGROUPED_ROW_KEY ? null : nextRowKey;
      const patch =
        groupByRow === 'assignee'
          ? { assigneeId: value }
          : { category: value };
      patchIssue.mutate(
        { id: issueId, patch: patch as never },
        { onError: (err) => addToast(formatApiError(err)) },
      );
    },
    [transitionIssue, patchIssue, addToast, groupByRow, issues],
  );

  const setWipLimit = useCallback(
    (status: IssueStatus, value: number | null) => {
      if (!projectId) return;
      updateBoardConfig.mutate(
        { projectId, wipLimits: { [status]: value } },
        { onError: (err) => addToast(formatApiError(err)) },
      );
    },
    [updateBoardConfig, projectId, addToast],
  );

  const toggleCol = (status: IssueStatus) => {
    setVisibleCols((prev) => ({ ...prev, [status]: !prev[status] }));
  };

  // Tasks view: fetch tasks per visible issue and flatten. Only enabled when
  // viewMode === 'tasks' so the issues view stays cheap. Core has no
  // project-level tasks endpoint, so the N+1 is intentional for v0.1.0.
  const taskQueries = useQueries({
    queries: issues.map((i) => ({
      queryKey: ['tasks', 'issue', i.id],
      queryFn: () => taskApi.listByIssue(i.id),
      enabled: viewMode === 'tasks' && !!i.id,
    })),
  });
  const tasks = useMemo<Task[]>(
    () => taskQueries.flatMap((q) => (q.data ?? []) as Task[]),
    [taskQueries],
  );
  const tasksLoading = viewMode === 'tasks' && taskQueries.some((q) => q.isLoading);

  const assignees = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) {
      if (t.assigneeId) set.add(t.assigneeId);
    }
    return Array.from(set).sort();
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (assigneeFilter !== 'all' && t.assigneeId !== assigneeFilter) return false;
      if (agentFilter === 'agent' && !t.isAgentTask) return false;
      if (agentFilter === 'human' && t.isAgentTask) return false;
      return true;
    });
  }, [tasks, assigneeFilter, agentFilter]);

  const changedTaskIds = useChangedIds(
    tasks.map((t) => ({ id: 0, documentId: t.id, status: t.status, updatedAt: t.updatedAt })),
  );

  const updateTask = useUpdateTask();
  const handleTaskDrop = useCallback(
    (taskId: string, status: string) => {
      updateTask.mutate(
        { id: taskId, data: { status: status as TaskStatus } },
        { onError: (err) => addToast(formatApiError(err)) },
      );
    },
    [updateTask, addToast],
  );

  return {
    slug,
    viewMode,
    setViewMode,
    loading: viewMode === 'issues' ? isLoading : tasksLoading,
    issues,
    selectedIssueId,
    setSelectedIssueId,
    changedIssueIds,
    visibleCols,
    showColPicker,
    setShowColPicker,
    toggleCol,
    handleIssueDrop,
    handleIssueDropCell,
    groupedIssues,
    density,
    setDensity,
    groupByRow,
    setGroupByRow,
    collapsedCols,
    toggleCollapsedCol,
    wipLimits,
    setWipLimit,
    tasks,
    filteredTasks,
    changedTaskIds,
    assignees,
    assigneeFilter,
    setAssigneeFilter,
    agentFilter,
    setAgentFilter,
    handleTaskDrop,
    toasts,
  };
}

