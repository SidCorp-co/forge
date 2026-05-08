import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { taskApi } from '../api/task-api';
import type { Task, TaskCreateInput, TaskPatchInput } from '../types';

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

export function useCreateTask(issueId: string, projectId: string) {
  const queryClient = useQueryClient();
  const cacheKey = ['tasks', 'issue', issueId] as const;
  return useMutation({
    mutationFn: (input: TaskCreateInput) => taskApi.create(issueId, input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ['tasks'] });
      const queries = queryClient.getQueriesData<Task[]>({ queryKey: ['tasks'] });
      const tempId = `temp-${
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2)
      }`;
      const current = queryClient.getQueryData<Task[]>(cacheKey) ?? [];
      const maxSort = current.reduce((m, t) => Math.max(m, t.sortOrder ?? 0), -1);
      const now = new Date().toISOString();
      const optimistic: Task = {
        id: tempId,
        issueId,
        projectId,
        title: input.title,
        description: input.description ?? null,
        status: input.status ?? 'todo',
        priority: input.priority ?? 'none',
        assigneeId: input.assigneeId ?? null,
        isAgentTask: input.isAgentTask ?? false,
        agentStatus: input.agentStatus ?? null,
        agentLog: input.agentLog ?? null,
        acceptanceCriteria: input.acceptanceCriteria ?? null,
        sortOrder: input.sortOrder ?? maxSort + 1,
        createdAt: now,
        updatedAt: now,
      };
      queryClient.setQueryData<Task[]>(cacheKey, [...current, optimistic]);
      return { queries, tempId };
    },
    onSuccess: (server, _input, ctx) => {
      if (!ctx) return;
      const current = queryClient.getQueryData<Task[]>(cacheKey);
      if (!current) return;
      queryClient.setQueryData<Task[]>(
        cacheKey,
        current.map((t) => (t.id === ctx.tempId ? server : t)),
      );
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

export function useDeleteTask(issueId: string) {
  const queryClient = useQueryClient();
  const cacheKey = ['tasks', 'issue', issueId] as const;
  return useMutation({
    mutationFn: (taskId: string) => taskApi.remove(taskId),
    onMutate: async (taskId) => {
      await queryClient.cancelQueries({ queryKey: ['tasks'] });
      const queries = queryClient.getQueriesData<Task[]>({ queryKey: ['tasks'] });
      const current = queryClient.getQueryData<Task[]>(cacheKey);
      if (current) {
        queryClient.setQueryData<Task[]>(
          cacheKey,
          current.filter((t) => t.id !== taskId),
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

export function useReorderTasks(issueId: string) {
  const queryClient = useQueryClient();
  const cacheKey = ['tasks', 'issue', issueId] as const;
  return useMutation({
    mutationFn: (taskIds: string[]) => taskApi.reorder(issueId, taskIds),
    onMutate: async (taskIds) => {
      await queryClient.cancelQueries({ queryKey: ['tasks'] });
      const queries = queryClient.getQueriesData<Task[]>({ queryKey: ['tasks'] });
      const current = queryClient.getQueryData<Task[]>(cacheKey);
      if (current) {
        const byId = new Map(current.map((t) => [t.id, t]));
        const reordered = taskIds
          .map((id, idx) => {
            const t = byId.get(id);
            return t ? { ...t, sortOrder: idx } : null;
          })
          .filter((t): t is Task => t !== null);
        queryClient.setQueryData<Task[]>(cacheKey, reordered);
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
