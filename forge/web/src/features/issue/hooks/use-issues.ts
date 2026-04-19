import { keepPreviousData, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { issueApi } from '../api/issue-api';
import type { IssueListParams } from '../api/issue-api';
import type { Issue, IssueFormData } from '../types';

export function useIssues(params: IssueListParams = {}) {
  return useQuery({
    queryKey: ['issues', params],
    queryFn: () => issueApi.getAll(params),
    enabled: params.projectSlug === undefined ? true : !!params.projectSlug,
    placeholderData: keepPreviousData,
  });
}

export function useAllIssues(projectSlug?: string) {
  return useQuery({
    queryKey: ['issues', 'all', projectSlug],
    queryFn: () => issueApi.getAllUnpaginated(projectSlug),
    enabled: projectSlug === undefined ? true : !!projectSlug,
  });
}

export function useIssue(id: string) {
  return useQuery({
    queryKey: ['issue', id],
    queryFn: () => issueApi.getById(id),
    enabled: !!id,
  });
}

export function useCreateIssue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: IssueFormData) => issueApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issues'] });
    },
  });
}

export function useUpdateIssue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Issue> }) =>
      issueApi.update(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: ['issues'] });
      const queries = queryClient.getQueriesData<{ data: Issue[] }>({ queryKey: ['issues'] });
      for (const [key, old] of queries) {
        if (!old?.data) continue;
        queryClient.setQueryData(key, {
          ...old,
          data: old.data.map((i) => (i.documentId === id ? { ...i, ...data } : i)),
        });
      }
      return { queries };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.queries) {
        for (const [key, old] of ctx.queries) {
          queryClient.setQueryData(key, old);
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      queryClient.invalidateQueries({ queryKey: ['issue'] });
    },
  });
}

export function useGateIssues(projectSlug?: string) {
  return useQuery({
    queryKey: ['issues', 'gate', projectSlug],
    queryFn: () => issueApi.getGateIssues(projectSlug!),
    enabled: !!projectSlug,
    staleTime: 10_000,
  });
}

export function useEnrichIssue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => issueApi.enrich(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      queryClient.invalidateQueries({ queryKey: ['issue'] });
    },
  });
}
