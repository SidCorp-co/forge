import { apiClient, apiClientList } from '@/lib/api/client';
import type { MemoryHit, MemoryRow, MemorySource } from './types';

interface ListParams {
  projectId: string;
  source?: MemorySource;
  limit?: number;
  offset?: number;
}

interface SearchParams {
  projectId: string;
  query: string;
  topK?: number;
  sourceFilter?: MemorySource[];
}

interface SearchResponse {
  hits: MemoryHit[];
  model: string;
  took_ms: number;
}

export const memoryApi = {
  /** Paginated list — `GET /api/memory`. Returns rows + the `X-Total-Count`. */
  list: ({ projectId, source, limit = 200, offset = 0 }: ListParams) => {
    const params = new URLSearchParams({
      projectId,
      limit: String(limit),
      offset: String(offset),
    });
    if (source) params.set('source', source);
    return apiClientList<MemoryRow>(`/memory?${params.toString()}`);
  },

  /** Semantic search — `POST /api/memory/search`. */
  search: ({ projectId, query, topK = 20, sourceFilter }: SearchParams) =>
    apiClient<SearchResponse>('/memory/search', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        query,
        topK,
        ...(sourceFilter && sourceFilter.length > 0 ? { sourceFilter } : {}),
      }),
    }),

  /** Idempotent delete by UUID — `DELETE /api/memory/:id`. */
  remove: (memoryId: string) =>
    apiClient<void>(`/memory/${encodeURIComponent(memoryId)}`, {
      method: 'DELETE',
    }),
};
