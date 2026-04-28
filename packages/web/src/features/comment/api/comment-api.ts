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
  parentId?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CoreCommentNode extends CoreComment {
  replies?: CoreCommentNode[];
}

function toLegacy(row: CoreComment): Comment {
  const parentId = row.parentId ?? null;
  return {
    id: 0,
    documentId: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    body: row.body,
    author: row.authorId,
    isAI: false,
    issue: { id: 0, documentId: row.issueId },
    parent: parentId ? { id: 0, documentId: parentId } : null,
    replies: [],
    mentions: [],
    attachments: [],
  };
}

function flattenTree(nodes: CoreCommentNode[]): Comment[] {
  const out: Comment[] = [];
  const walk = (node: CoreCommentNode) => {
    out.push(toLegacy(node));
    for (const child of node.replies ?? []) walk(child);
  };
  for (const root of nodes) walk(root);
  return out;
}

export const commentApi = {
  getByIssue: async (issueId: string): Promise<{ data: Comment[] }> => {
    // Backend now returns a CommentNode tree (depth ≤ 3) instead of a flat
    // list. Flatten so existing consumers that expect a flat array keep
    // working; replies are still discoverable via `parent.documentId`.
    const tree = await apiClient<CoreCommentNode[]>(`/issues/${issueId}/comments`);
    return { data: flattenTree(tree) };
  },

  create: async (issueId: string, data: CommentFormData): Promise<{ data: Comment }> => {
    const payload: { body: string; parentId?: string } = { body: data.body };
    if (data.parent) payload.parentId = data.parent;
    const row = await apiClient<CoreComment>(`/issues/${issueId}/comments`, {
      method: 'POST',
      body: JSON.stringify(payload),
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
