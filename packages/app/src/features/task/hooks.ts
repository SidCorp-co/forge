import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import type { Task } from './types';

const taskApi = {
  getAll: () =>
    apiClient<{ data: Task[] }>('/tasks?populate=*'),

  getByProject: (projectSlug?: string) => {
    const filter = projectSlug
      ? `?filters[issue][project][slug][$eq]=${projectSlug}&populate=*`
      : '?populate=*';
    return apiClient<{ data: Task[] }>(`/tasks${filter}`);
  },

  getById: (id: string) =>
    apiClient<{ data: Task }>(`/tasks/${id}?populate=*`),

  update: (id: string, data: Partial<Task>) =>
    apiClient<{ data: Task }>(`/tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),
};

export function useTasks(projectSlug?: string) {
  return useQuery({
    queryKey: ['tasks', projectSlug],
    queryFn: () => taskApi.getByProject(projectSlug),
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Task> }) =>
      taskApi.update(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: ['tasks'] });
      const queries = queryClient.getQueriesData<{ data: Task[] }>({ queryKey: ['tasks'] });
      for (const [key, old] of queries) {
        if (!old?.data) continue;
        queryClient.setQueryData(key, {
          ...old,
          data: old.data.map((t) => (t.documentId === id ? { ...t, ...data } : t)),
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
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
