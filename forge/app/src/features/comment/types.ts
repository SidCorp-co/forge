import type { BaseEntity } from '@/lib/types';

export interface Comment extends BaseEntity {
  body: string;
  author: string;
  isAI: boolean;
  issue: { id: number; documentId: string } | null;
  parent: { id: number; documentId: string } | null;
  replies: Comment[];
  mentions: string[];
}

export interface CommentFormData {
  body: string;
  author?: string;
  issue: string;
  parent?: string;
}
