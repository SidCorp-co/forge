import { apiClient } from '@/lib/api/client';
import type { ChatLog, ChatLogFilters, ChatLogListResponse } from './types';

// Core returns chat_logs rows with `id` (uuid) only. ChatLog extends BaseEntity
// which expects `documentId`, so adapt at the API boundary to keep table keys,
// row selection, and getById cache lookups working.
function toChatLog(row: Record<string, unknown>): ChatLog {
  const id = row['id'] as string;
  return {
    ...(row as object),
    id: 0,
    documentId: id,
  } as unknown as ChatLog;
}

export const chatLogApi = {
  getAll: async (filters: ChatLogFilters = {}): Promise<ChatLogListResponse> => {
    const qs = new URLSearchParams();
    qs.set('page', String(filters.page ?? 1));
    qs.set('pageSize', String(filters.pageSize ?? 25));
    if (filters.projectSlug) qs.set('projectSlug', filters.projectSlug);
    if (filters.intent) qs.set('intent', filters.intent);
    if (filters.source) qs.set('source', filters.source);
    if (filters.qaRating) qs.set('qaRating', filters.qaRating);
    if (filters.dateFrom) qs.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) qs.set('dateTo', filters.dateTo);
    const res = await apiClient<{
      data: Record<string, unknown>[];
      meta: ChatLogListResponse['meta'];
    }>(`/chat-logs?${qs.toString()}`);
    return { data: res.data.map(toChatLog), meta: res.meta };
  },

  getById: async (id: string): Promise<ChatLog> => {
    const row = await apiClient<Record<string, unknown>>(`/chat-logs/${id}`);
    return toChatLog(row);
  },

  updateRating: (id: string, qaRating: string | null, qaNotes?: string) =>
    apiClient<{ id: string; qaRating: string | null; qaNotes: string | null }>(`/chat-logs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ qaRating, qaNotes }),
    }),
};
