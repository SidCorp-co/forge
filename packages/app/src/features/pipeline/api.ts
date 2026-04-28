import { apiClient } from '@/lib/api-client';
import type { PipelineSession, PipelineFilter } from './types';

const BASE_PARAMS = [
  'populate[project][fields][0]=name',
  'populate[project][fields][1]=slug',
  'populate[issues][fields][0]=title',
  'populate[issues][fields][1]=status',
  'filters[metadata][type][$eq]=pipeline',
  'sort=createdAt:desc',
  'pagination[pageSize]=50',
].join('&');

export const pipelineApi = {
  getSessions: (filter: PipelineFilter) => {
    const statusFilter =
      filter === 'active'
        ? '&filters[status][$in][0]=queued&filters[status][$in][1]=running'
        : '';
    return apiClient<{ data: PipelineSession[] }>(
      `/agent-sessions?${BASE_PARAMS}${statusFilter}`,
    );
  },

  cancelSession: (documentId: string) =>
    apiClient(`/agent-sessions/${documentId}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { status: 'failed' } }),
    }),

  deleteSession: (documentId: string) =>
    apiClient(`/agent-sessions/${documentId}`, { method: 'DELETE' }),
};
