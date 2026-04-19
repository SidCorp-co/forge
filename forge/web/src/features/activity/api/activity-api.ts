import { apiClient } from '@/lib/api/client';
import type { Activity } from '../types';

export const activityApi = {
  getByIssue: (issueDocumentId: string) =>
    apiClient<{ data: Activity[] }>(
      `/activities?filters[issue][documentId][$eq]=${issueDocumentId}&sort=createdAt:desc&pagination[pageSize]=200`
    ),

  evaluate: (documentId: string, verdict: 'approve' | 'reject', note?: string) =>
    apiClient<{ data: { documentId: string; verdict: string } }>(
      `/activities/${documentId}/evaluate`,
      { method: 'PUT', body: JSON.stringify({ verdict, note }) },
    ),

  delete: (documentId: string) =>
    apiClient<{ data: { documentId: string; deleted: boolean } }>(
      `/activities/${documentId}`,
      { method: 'DELETE' },
    ),
};
