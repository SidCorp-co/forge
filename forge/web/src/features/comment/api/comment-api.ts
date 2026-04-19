import { apiClient, apiUpload } from '@/lib/api/client';
import type { Comment, CommentFormData } from '../types';

export const commentApi = {
  getByIssue: (issueDocumentId: string) =>
    apiClient<{ data: Comment[] }>(
      `/comments?filters[issue][documentId][$eq]=${issueDocumentId}&populate=*`
    ),

  create: (data: CommentFormData) =>
    apiClient<{ data: Comment }>('/comments', {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  update: (documentId: string, data: { body: string }) =>
    apiClient<{ data: Comment }>(`/comments/${documentId}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  delete: (documentId: string) =>
    apiClient<void>(`/comments/${documentId}`, {
      method: 'DELETE',
    }),

  uploadFile: async (file: File): Promise<{ id: number; url: string; name: string } | null> => {
    const formData = new FormData();
    formData.append('files', file);
    try {
      const uploaded = await apiUpload(formData);
      const first = uploaded[0];
      if (!first?.id) return null;
      return { id: first.id, url: first.url, name: file.name };
    } catch {
      return null;
    }
  },
};
