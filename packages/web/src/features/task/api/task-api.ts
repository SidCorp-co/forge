import { apiClient } from '@/lib/api/client';
import type { Task, TaskCreateInput, TaskPatchInput } from '../types';

export const taskApi = {
  listByIssue: (issueId: string) => apiClient<Task[]>(`/issues/${issueId}/tasks`),

  get: (taskId: string) => apiClient<Task>(`/tasks/${taskId}`),

  create: (issueId: string, input: TaskCreateInput) =>
    apiClient<Task>(`/issues/${issueId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  patch: (taskId: string, input: TaskPatchInput) =>
    apiClient<Task>(`/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  remove: (taskId: string) => apiClient<void>(`/tasks/${taskId}`, { method: 'DELETE' }),

  reorder: (issueId: string, taskIds: string[]) =>
    apiClient<void>(`/issues/${issueId}/tasks/reorder`, {
      method: 'POST',
      body: JSON.stringify({ taskIds }),
    }),
};
