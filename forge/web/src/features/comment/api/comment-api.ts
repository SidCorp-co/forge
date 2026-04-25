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

interface CoreComment {
  id: string;
  issueId: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

function toLegacy(row: CoreComment): Comment {
  return {
    id: 0,
    documentId: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    body: row.body,
    author: row.authorId,
    isAI: false,
    issue: { id: 0, documentId: row.issueId },
    parent: null,
    replies: [],
    mentions: [],
    attachments: [],
  } as Comment;
}

export const commentApi = {
  getByIssue: async (issueId: string): Promise<{ data: Comment[] }> => {
    const rows = await apiClient<CoreComment[]>(`/issues/${issueId}/comments?limit=200`);
    return { data: rows.map(toLegacy) };
  },

  create: async (issueId: string, data: CommentFormData): Promise<{ data: Comment }> => {
    const row = await apiClient<CoreComment>(`/issues/${issueId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: data.body }),
    });
    return { data: toLegacy(row) };
  },

  update: async (commentId: string, data: { body: string }): Promise<{ data: Comment }> => {
    const row = await apiClient<CoreComment>(`/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    return { data: toLegacy(row) };
  },

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
