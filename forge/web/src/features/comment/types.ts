import type { BaseEntity } from '@/lib/types';

export interface Comment extends BaseEntity {
  body: string;
  author: string;
  isAI: boolean;
  issue: { id: number; documentId: string } | null;
  parent: { id: number; documentId: string } | null;
  replies: Comment[];
  mentions: string[];
  attachments: { id: number; url: string; name: string; mime: string }[];
}

export interface CommentFormData {
  body: string;
  author?: string;
  issue: string; // documentId
  parent?: string; // parent comment documentId for replies
  attachments?: number[]; // Strapi media IDs
}
