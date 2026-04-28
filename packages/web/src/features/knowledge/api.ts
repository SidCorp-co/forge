import { apiClient } from '@/lib/api/client';
import type {
  KnowledgeEdge,
  KnowledgeEdgeInput,
  KnowledgeIngestDocument,
  KnowledgeIngestResult,
} from './types';

export const knowledgeApi = {
  listEdges: (
    projectId: string,
    filters?: { subject?: string; predicate?: string; object?: string; limit?: number },
  ) => {
    const params = new URLSearchParams({ projectId });
    if (filters?.subject) params.set('subject', filters.subject);
    if (filters?.predicate) params.set('predicate', filters.predicate);
    if (filters?.object) params.set('object', filters.object);
    if (filters?.limit) params.set('limit', String(filters.limit));
    return apiClient<KnowledgeEdge[]>(`/knowledge-edges?${params.toString()}`);
  },

  createEdge: (input: KnowledgeEdgeInput) =>
    apiClient<KnowledgeEdge>('/knowledge-edges', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteEdge: (id: string) =>
    apiClient<null>(`/knowledge-edges/${id}`, { method: 'DELETE' }),

  ingest: (projectId: string, documents: KnowledgeIngestDocument[]) =>
    apiClient<KnowledgeIngestResult>('/knowledge/ingest', {
      method: 'POST',
      body: JSON.stringify({ projectId, documents }),
    }),
};
