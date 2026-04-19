import { apiClient } from '@/lib/api/client';
import type { Label, LabelFormData } from '../types';

export const labelApi = {
  getByProject: (projectDocumentId: string) =>
    apiClient<{ data: Label[] }>(
      `/labels?filters[project][documentId][$eq]=${projectDocumentId}&populate=*`
    ),

  create: (data: LabelFormData) =>
    apiClient<{ data: Label }>('/labels', {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  update: (documentId: string, data: Partial<LabelFormData>) =>
    apiClient<{ data: Label }>(`/labels/${documentId}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  delete: (documentId: string) =>
    apiClient(`/labels/${documentId}`, { method: 'DELETE' }),
};
