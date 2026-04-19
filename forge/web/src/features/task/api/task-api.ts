import { apiClient } from '@/lib/api/client';
import type { Task } from '../types';

export const taskApi = {
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
