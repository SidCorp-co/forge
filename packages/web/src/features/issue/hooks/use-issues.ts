'use client';

import type { Issue, IssueCreateInput, IssuePatchInput } from '@forge/contracts';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type IssueListParams,
  type IssueSearchParams,
  type PipelineStage,
  issueApi,
} from '../api/issue-api';

/**
 * Stable React Query keys — F3's WS event router uses these exact tuples.
 * Do not rename without syncing `src/lib/ws/event-router.ts`.
 */
export const issueKeys = {
  all: ['issues'] as const,
  lists: ['issues', 'list'] as const,
  list: (params: IssueListParams) => ['issues', 'list', params] as const,
  searches: ['issues', 'search'] as const,
  search: (params: IssueSearchParams) => ['issues', 'search', params] as const,
  details: ['issue'] as const,
  detail: (id: string | undefined) => ['issue', id] as const,
  detailByDisplay: (projectId: string | undefined, displayId: string | undefined) =>
    ['issue', 'by-display', projectId, displayId] as const,
};

type ListPage = { items: Issue[]; totalCount: number };

export function useIssues(params: IssueListParams) {
  return useQuery({
    queryKey: issueKeys.list(params),
    queryFn: () => issueApi.list(params),
    enabled: !!params.projectId,
    placeholderData: keepPreviousData,
  });
}

export function useIssueSearch(params: IssueSearchParams) {
  return useQuery({
    queryKey: issueKeys.search(params),
    queryFn: () => issueApi.search(params),
    enabled: !!params.projectId,
    placeholderData: keepPreviousData,
  });
}

export function useIssue(id: string | undefined) {
  return useQuery({
    queryKey: issueKeys.detail(id),
    queryFn: () => issueApi.get(id as string),
    enabled: !!id,
  });
}

export function useIssueByDisplay(
  projectId: string | undefined,
  displayId: string | undefined,
) {
  return useQuery({
    queryKey: issueKeys.detailByDisplay(projectId, displayId),
    queryFn: () => issueApi.getByDisplay(projectId as string, displayId as string),
    enabled: !!projectId && !!displayId,
  });
}

export function useCreateIssue(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: IssueCreateInput) => {
      if (!projectId) throw new Error('projectId is required to create an issue');
      return issueApi.create(projectId, input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: issueKeys.lists });
      qc.invalidateQueries({ queryKey: issueKeys.searches });
    },
  });
}

export function usePatchIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: IssuePatchInput }) =>
      issueApi.patch(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: issueKeys.lists });
      const snapshots = qc.getQueriesData<ListPage>({ queryKey: issueKeys.lists });
      for (const [key, old] of snapshots) {
        if (!old) continue;
        qc.setQueryData<ListPage>(key, {
          ...old,
          items: old.items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
        });
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      ctx?.snapshots?.forEach(([key, old]) => qc.setQueryData(key, old));
    },
    onSettled: (_data, _err, { id }) => {
      qc.invalidateQueries({ queryKey: issueKeys.lists });
      qc.invalidateQueries({ queryKey: issueKeys.searches });
      qc.invalidateQueries({ queryKey: issueKeys.details });
    },
  });
}

export function useTransitionIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      toStatus,
      reason,
      override,
    }: {
      id: string;
      toStatus: string;
      reason?: string;
      override?: boolean;
    }) =>
      issueApi.transition(id, {
        toStatus,
        ...(reason !== undefined ? { reason } : {}),
        ...(override !== undefined ? { override } : {}),
      }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: issueKeys.lists });
      qc.invalidateQueries({ queryKey: issueKeys.searches });
      qc.invalidateQueries({ queryKey: issueKeys.details });
    },
  });
}

/**
 * ISS-5: manually fire a pipeline stage for an issue. Bypasses the project's
 * `auto*` toggles. `stage` undefined → server resolves from current status.
 */
export function useRunPipelineStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, stage }: { id: string; stage?: PipelineStage }) =>
      issueApi.runPipelineStep(id, stage),
    onSuccess: () => {
      // Job → agent_sessions row (ISS-4) appears via WS; explicit invalidate so
      // the issue's Agent Sessions tab refetches immediately on click.
      qc.invalidateQueries({ queryKey: ['agent-sessions'] });
      qc.invalidateQueries({ queryKey: issueKeys.details });
    },
  });
}

export function useDeleteIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => issueApi.remove(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: issueKeys.lists });
      qc.invalidateQueries({ queryKey: issueKeys.searches });
      qc.invalidateQueries({ queryKey: issueKeys.details });
    },
  });
}
