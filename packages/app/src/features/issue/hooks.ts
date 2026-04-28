import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { issueApi } from './api';
import type { Issue, IssueFormData } from './types';

export function useIssues(projectSlug?: string) {
  return useQuery({
    queryKey: ['issues', projectSlug],
    queryFn: () => issueApi.getAll(projectSlug),
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
