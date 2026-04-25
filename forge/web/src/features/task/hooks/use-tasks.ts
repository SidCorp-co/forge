import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { taskApi } from '../api/task-api';
import type { Task, TaskPatchInput } from '../types';

export function useIssueTasks(issueId: string | undefined) {
  return useQuery({
    queryKey: ['tasks', 'issue', issueId],
    queryFn: () => taskApi.listByIssue(issueId as string),
    enabled: !!issueId,
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: TaskPatchInput }) => taskApi.patch(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: ['tasks'] });
      const queries = queryClient.getQueriesData<Task[]>({ queryKey: ['tasks'] });
      for (const [key, old] of queries) {
        if (!Array.isArray(old)) continue;
        queryClient.setQueryData(
          key,
          old.map((t) => (t.id === id ? { ...t, ...data } : t)),
        );
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
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
