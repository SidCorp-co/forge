import { apiClient, apiMultipart } from '@/lib/api/client';
import type { Comment, CommentFormData } from '../types';

export interface CommentAttachment {
  id: string;
  commentId: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  createdAt: string;
}

export const commentApi = {
  getByIssue: (issueId: string) =>
    apiClient<Comment[]>(`/issues/${issueId}/comments?limit=200`),

  create: (issueId: string, data: CommentFormData) =>
    apiClient<Comment>(`/issues/${issueId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: data.body }),
    }),

  update: (commentId: string, data: { body: string }) =>
    apiClient<Comment>(`/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  delete: (commentId: string) =>
    apiClient<void>(`/comments/${commentId}`, {
      method: 'DELETE',
    }),

  uploadAttachment: async (commentId: string, file: File): Promise<CommentAttachment | null> => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      return await apiMultipart<CommentAttachment>(
        `/comments/${commentId}/attachments`,
        formData,
      );
    } catch {
      return null;
    }
  },
};
