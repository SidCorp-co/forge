'use client';

import { useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useTasks, useUpdateTask } from '@/features/task/hooks/use-tasks';
import { useAllIssues, useUpdateIssue } from '@/features/issue/hooks/use-issues';
import { useToast } from '@/hooks/use-toast';
import { useChangedIds } from '@/hooks/use-changed-ids';
import { useCountChangeToast, useChangedItemsToast } from '@/hooks/use-board-toasts';
import { DEFAULT_VISIBLE } from '../constants';
import type { IssueStatus } from '@/features/issue/types';
import type { TaskStatus } from '@/features/task/types';

export function useBoard() {
  const { slug } = useParams<{ slug: string }>();

  const [viewMode, setViewMode] = useState<'issues' | 'tasks'>('issues');
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [visibleCols, setVisibleCols] = useState<Record<IssueStatus, boolean>>(DEFAULT_VISIBLE);
  const [showColPicker, setShowColPicker] = useState(false);
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  const { data, isLoading } = useTasks(slug);
  const { data: issuesData, isLoading: issuesLoading } = useAllIssues(slug);
  const updateIssue = useUpdateIssue();
  const updateTask = useUpdateTask();

  const tasks = data?.data ?? [];
  const issues = issuesData?.data ?? [];

  const changedIssueIds = useChangedIds(issues);
  const changedTaskIds = useChangedIds(tasks);

  const { toasts, addToast } = useToast();
  useCountChangeToast(issues.length, 'issue', addToast);
  useCountChangeToast(tasks.length, 'task', addToast);
  useChangedItemsToast(changedIssueIds, issues, addToast);
  useChangedItemsToast(changedTaskIds, tasks, addToast);

  const assignees = Array.from(new Set(tasks.map((t) => t.assignee).filter(Boolean))) as string[];

  const filteredTasks = tasks.filter((t) => {
    if (assigneeFilter !== 'all' && t.assignee !== assigneeFilter) return false;
    if (agentFilter !== 'all' && t.agentStatus !== agentFilter) return false;
    return true;
  });

  const handleIssueDrop = useCallback(
    (issueId: string, status: string) => {
      updateIssue.mutate({ id: issueId, data: { status: status as IssueStatus } });
    },
    [updateIssue],
  );

  const handleTaskDrop = useCallback(
    (taskId: string, status: string) => {
      updateTask.mutate({ id: taskId, data: { status: status as TaskStatus } });
    },
    [updateTask],
  );

  const toggleCol = (status: IssueStatus) => {
    setVisibleCols((prev) => ({ ...prev, [status]: !prev[status] }));
  };

  const loading = viewMode === 'tasks' ? isLoading : issuesLoading;

  return {
    // view state
    viewMode,
    setViewMode,
    loading,
    // issues
    issues,
    selectedIssueId,
    setSelectedIssueId,
    changedIssueIds,
    visibleCols,
    showColPicker,
    setShowColPicker,
    toggleCol,
    handleIssueDrop,
    // tasks
    tasks,
    filteredTasks,
    changedTaskIds,
    assignees,
    assigneeFilter,
    setAssigneeFilter,
    agentFilter,
    setAgentFilter,
    handleTaskDrop,
    // toasts
    toasts,
  };
}
