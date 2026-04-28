import type { BaseEntity } from '@/lib/types';

export type QaRating = 'good' | 'bad' | 'flagged';

export interface RagHit {
  title?: string;
  source?: string;
  content?: string;
  score?: number;
  [key: string]: unknown;
}

export interface ToolCall {
  name?: string;
  tool?: string;
  [key: string]: unknown;
}

export interface ChatLog extends BaseEntity {
  sessionId: string;
  projectSlug: string;
  userKey: string | null;
  query: string;
  reply: string | null;
  model: string | null;
  ragContext: RagHit[] | null;
  toolCalls: ToolCall[] | null;
  usage: { input_tokens?: number; output_tokens?: number } | null;
  iterations: number;
  durationMs: number | null;
  error: string | null;
  queryIntent: string | null;
  condensedQuery: string | null;
  source: string;
  qualitySignals: Record<string, unknown> | null;
  qaRating: QaRating | null;
  qaNotes: string | null;
}

export interface ChatLogFilters {
  projectSlug?: string;
  intent?: string;
  source?: string;
  qaRating?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface ChatLogListResponse {
  data: ChatLog[];
  meta: {
    pagination: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
}
