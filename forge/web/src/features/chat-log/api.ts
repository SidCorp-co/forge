import { apiClient } from '@/lib/api/client';
import type { ChatLog, ChatLogFilters, ChatLogListResponse } from './types';

export const chatLogApi = {
  getAll: (filters: ChatLogFilters = {}) => {
    const qs = new URLSearchParams();
    qs.set('page', String(filters.page ?? 1));
    qs.set('pageSize', String(filters.pageSize ?? 25));
    if (filters.projectSlug) qs.set('projectSlug', filters.projectSlug);
    if (filters.intent) qs.set('intent', filters.intent);
    if (filters.source) qs.set('source', filters.source);
    if (filters.qaRating) qs.set('qaRating', filters.qaRating);
    if (filters.dateFrom) qs.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) qs.set('dateTo', filters.dateTo);
    return apiClient<ChatLogListResponse>(`/chat-logs?${qs.toString()}`);
  },

  getById: (id: string) =>
    apiClient<ChatLog>(`/chat-logs/${id}`),

  updateRating: (id: string, qaRating: string | null, qaNotes?: string) =>
    apiClient<{ id: string; qaRating: string | null; qaNotes: string | null }>(`/chat-logs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ qaRating, qaNotes }),
    }),
};
