import { apiClient } from '@/lib/api/client';
import type { Memory } from './types';

export const memoryApi = {
  list: (projectDocumentId: string) =>
    apiClient<{ data: Memory[] }>(`/memories?projectDocumentId=${encodeURIComponent(projectDocumentId)}`),

  remove: (sourceId: string) =>
    apiClient<{ data: { ok: boolean } }>(`/memories/${encodeURIComponent(sourceId)}`, {
      method: 'DELETE',
    }),
};
